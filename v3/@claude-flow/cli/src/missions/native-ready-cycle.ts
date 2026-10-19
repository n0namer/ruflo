/**
 * ADR-406 M2: thin bounded once/refill adapter over existing Native components.
 * No new planner, executor, QA authority, lease store or journal is created.
 * This is a caller-driven slice, NOT a background daemon.
 */
import { MissionStore } from './store.js';
import { MissionService } from './service.js';
import { readyTaskIdsFromMission } from './execution-frontier.js';
import type { MissionView } from './transitions.js';
import type { CodexPortObservation } from './execution-m2-r7-codex-port.js';
import type { CodexDispatchReceipt } from './execution-dispatch-binding.js';

export interface VerifiedTaskResult {
  readonly accepted: true;
  readonly artifactDigest: string;
  readonly reviewerRunId: string;
  readonly evidenceId: string;
}
export interface NativeReadyCycleOptions {
  readonly projectRoot: string;
  readonly missionId: string;
  /** Must be a trusted internal MissionService with Native event authorization. */
  readonly runtime: Pick<MissionService, 'recordNativeEvent'>;
  readonly executorId: string;
  /** Stable identity of the caller-owned cycle, not a client-provided grant. */
  readonly cycleId: string;
  readonly maxTasks: number;
  /** Existing Factory Guardian/Human/provider-slot gate, rechecked before EACH physical dispatch. */
  readonly beforeDispatch?: (taskId: string, view: MissionView) => boolean | Promise<boolean>;
  /** Existing lease/journal/credential-fenced CodexMissionPort only. */
  readonly dispatch: (taskId: string, view: MissionView) => Promise<CodexPortObservation>;
  /** Independent reviewer fetches/checks original artifact and provider receipts. */
  readonly review: (taskId: string, receipt: CodexDispatchReceipt, view: MissionView) =>
    Promise<VerifiedTaskResult | null>;
  /** Persist verified outcome in the EXISTING invocation journal before Native task.done. */
  readonly settle: (taskId: string, receipt: CodexDispatchReceipt, qa: VerifiedTaskResult) =>
    Promise<boolean>;
  /**
   * Optional read-only, TRUSTED recovery from an already-succeeded invocation.
   * The host must verify the original ExecutionInvocationJournal receipt is
   * succeeded and its outcomeDigest, invocationId, source, lease, and independent
   * QA receipt all match this mission/plan. Never invent authority from payloads.
   * A null result NEVER permits a replay of a dispatched invocation.
   */
  readonly recoverSettled?: (taskId: string, view: MissionView) =>
    Promise<(VerifiedTaskResult & { readonly invocationId: string }) | null>;
}

export type NativeReadyCycleResult = {
  readonly status: 'completed' | 'partial' | 'blocked';
  readonly missionId: string;
  readonly performed: readonly string[];
  readonly state: string;
  readonly reason?: string;
};

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function runNativeReadyCycle(options: NativeReadyCycleOptions): Promise<NativeReadyCycleResult> {
  const { missionId, projectRoot, runtime } = options;
  if (!Number.isInteger(options.maxTasks) || options.maxTasks < 1 || options.maxTasks > 64) {
    throw new RangeError('maxTasks must be between 1 and 64');
  }
  if (!ID.test(options.cycleId) || !ID.test(options.executorId)) {
    throw new TypeError('stable cycleId and executorId are required');
  }
  const store = new MissionStore(projectRoot);
  const read = () => store.loadView(missionId);
  let view = read();
  if (!view || !view.planBody) return {
    status: 'blocked', missionId, performed: [], state: view?.record.state ?? 'missing', reason: 'no-durable-plan',
  };
  const done: string[] = [];
  const result = (status: NativeReadyCycleResult['status'], reason?: string): NativeReadyCycleResult => ({
    status, missionId, performed: [...done], state: read()?.record.state ?? 'missing',
    ...(reason ? { reason } : {}),
  });
  const write = async (id: string, kind: string,
    payload: Record<string, unknown>) => {
    const latest = read();
    if (!latest) return false;
    const event = await runtime.recordNativeEvent({
      requestId: id, missionId, expectedRevision: latest.record.revision, type: kind, payload,
    });
    return event.ok;
  };
  if (view.record.state === 'queued') {
    if (!await write(options.cycleId + ':ack', 'executor.acknowledged', {
      executorId: options.executorId, leaseEpoch: view.lease.epoch,
    })) return result('blocked', 'native-executor-ack-refused');
    view = read()!;
  }
  if (!['running', 'verifying'].includes(view.record.state)) return result('blocked', 'not-running');

  const validQa = (qa: VerifiedTaskResult | null): qa is VerifiedTaskResult =>
    !!qa && qa.accepted === true && SHA256.test(qa.artifactDigest) &&
    ID.test(qa.evidenceId) && ID.test(qa.reviewerRunId);

  /** Append from an authenticated, already-durable QA outcome only. */
  const appendAccepted = async (
    taskId: string, taskView: MissionView, invocationId: string, qa: VerifiedTaskResult,
    recovering: boolean,
  ): Promise<boolean> => {
    const observed = taskView.tasks[taskId];
    if (recovering && (!ID.test(invocationId) || !validQa(qa) ||
      qa.reviewerRunId === invocationId ||
      (observed?.invocationId && observed.invocationId !== invocationId))) return false;
    if (observed?.status !== 'recorded-done') {
      if (!await write(options.cycleId + ':' + taskId + ':done', 'task.observed', {
        taskId, status: 'recorded-done', leaseEpoch: taskView.lease.epoch, invocationId,
      })) return false;
    }
    const spec = taskView.planBody?.tasks.find(t => t.id === taskId);
    for (const criterionId of spec?.acceptanceEvidence ?? []) {
      const criterion = taskView.planBody?.acceptance.find(c => c.id === criterionId);
      if (!criterion) return false;
      const latest = read();
      // Check current revision AND criteria digest: old evidence cannot be reused.
      if (latest?.evidence.some(e => e.taskId === taskId &&
          e.criterionId === criterionId && e.verified &&
          e.planRevision === latest.record.plan.revision &&
          e.criteriaDigest === latest.record.acceptance.criteriaDigest &&
          e.artifactDigest === qa.artifactDigest)) continue;
      if (!await write(options.cycleId + ':' + taskId + ':qa:' + criterionId,
        'evidence.recorded', {
          evidenceId: qa.evidenceId + ':' + criterionId, criterionId, taskId,
          producer: criterion.producer, artifactDigest: qa.artifactDigest, verified: true,
        })) return false;
    }
    return true;
  };

  if (view.record.state === 'running') {
  // Recover evidence missing after a crash between durable task completion and
  // QA observation. Do not dispatch a completed task to repair its evidence.
  view = read()!;
  for (const spec of view.planBody!.tasks) {
    if (view.tasks[spec.id]?.status !== 'recorded-done') continue;
    const missing = spec.acceptanceEvidence.some(criterionId =>
      !view!.evidence.some(e => e.taskId === spec.id &&
        e.criterionId === criterionId && e.verified &&
        e.planRevision === view!.record.plan.revision &&
        e.criteriaDigest === view!.record.acceptance.criteriaDigest));
    if (!missing) continue;
    let recovered: Awaited<ReturnType<NonNullable<NativeReadyCycleOptions['recoverSettled']>>> = null;
    try { recovered = await options.recoverSettled?.(spec.id, view) ?? null; } catch { /* fail closed */ }
    if (!recovered || !validQa(recovered) ||
      !await appendAccepted(spec.id, view, recovered.invocationId, recovered, true)) {
      return result('blocked', 'evidence-recovery-required');
    }
    view = read()!;
  }

  for (let i = 0; i < options.maxTasks; i++) {
    view = read()!;
    const [taskId] = readyTaskIdsFromMission(view, 1);
    if (!taskId) break;
    // A crash may follow a confirmed journal settlement before task.observed.
    // Recover only from independently attested durable receipts; never redisp.
    let recovered: Awaited<ReturnType<NonNullable<NativeReadyCycleOptions['recoverSettled']>>> = null;
    try { recovered = await options.recoverSettled?.(taskId, view) ?? null; } catch { /* fail closed */ }
    if (recovered) {
      if (!validQa(recovered) || !ID.test(recovered.invocationId) ||
          !await appendAccepted(taskId, view, recovered.invocationId, recovered, true)) {
        return result('blocked', 'settlement-recovery-refused');
      }
      done.push(taskId);
      continue;
    }
    let admitted = false;
    try { admitted = options.beforeDispatch ? await options.beforeDispatch(taskId, view) === true : true; }
    catch { admitted = false; }
    if (!admitted) return result('blocked', 'factory-admission-revoked');
    let observation: CodexPortObservation;
    try {
      observation = await options.dispatch(taskId, view);
    } catch {
      // Side effect may have started. Never automatically replay this invocation.
      return result('blocked', 'dispatch-unknown');
    }
    const receipt = observation.receipt;
    if (observation.status !== 'observed' || receipt?.status !== 'completed' ||
        !Number.isSafeInteger(receipt.pid) || receipt.pid! <= 0 ||
        !receipt.physicalThreadId || !SHA256.test(view.record.plan.digest)) {
      // A failed/unknown physical invocation remains unresolved for reconciliation.
      if (observation.status === 'observed' || observation.status === 'unknown') {
        await write(options.cycleId + ':' + taskId + ':unknown', 'task.observed', {
          taskId, status: 'unknown', leaseEpoch: view.lease.epoch,
          invocationId: receipt?.invocationId ?? 'unattributed',
        });
      }
      return result('blocked', 'no-trusted-physical-completion');
    }

    let qa: VerifiedTaskResult | null;
    try { qa = await options.review(taskId, receipt, view); } catch { qa = null; }
    if (!validQa(qa) || qa.reviewerRunId === receipt.invocationId) {
      await write(options.cycleId + ':' + taskId + ':qa-unknown', 'task.observed', {
        taskId, status: 'unknown', leaseEpoch: view.lease.epoch,
        invocationId: receipt.invocationId,
      });
      return result('blocked', 'qa-not-verified');
    }
    let settled = false;
    try { settled = await options.settle(taskId, receipt, qa); } catch { /* fail closed */ }
    if (!settled) return result('blocked', 'journal-settlement-unconfirmed');

    if (!await appendAccepted(taskId, view, receipt.invocationId, qa, false)) {
      return result('blocked', 'native-task-or-independent-qa-refused');
    }
    done.push(taskId);
  }
  } // Once a Mission is verifying, replay ONLY its terminal decision, never workers.
  view = read()!;
  if (view.planBody?.tasks.some(t => view!.tasks[t.id]?.status !== 'recorded-done') ||
      view.unresolvedOperations.length) return result('partial', 'awaiting-more-accepted-ready');

  // Choose any *current-plan* digest covering ALL mandatory criteria. Old
  // evidence or a partially-covered digest must never shadow a valid set.
  const mandatory = view.planBody!.acceptance.filter(c => c.mandatory);
  const currentEvidence = view.evidence.filter(e => e.verified &&
    e.planRevision === view.record.plan.revision &&
    e.criteriaDigest === view.record.acceptance.criteriaDigest &&
    SHA256.test(e.artifactDigest));
  const digest = [...new Set(currentEvidence.map(e => e.artifactDigest))].find(candidate =>
    mandatory.every(c => currentEvidence.some(e =>
      e.criterionId === c.id && e.artifactDigest === candidate)));
  if (!digest) return result('blocked', 'mandatory-qa-evidence-missing');
  if (view.record.state === 'running') {
    if (!await write(options.cycleId + ':settled', 'tasks.settled', {})) {
      return result('blocked', 'native-settlement-refused');
    }
  } else if (view.record.state !== 'verifying') {
    return result('blocked', 'not-verifying');
  }
  if (!await write(options.cycleId + ':terminal', 'acceptance.passed', { artifactDigest: digest })) {
    return result('blocked', 'native-terminal-refused');
  }
  return result('completed');
}
