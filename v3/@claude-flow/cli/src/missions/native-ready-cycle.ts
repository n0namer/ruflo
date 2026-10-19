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
  /** Existing lease/journal/credential-fenced CodexMissionPort only. */
  readonly dispatch: (taskId: string, view: MissionView) => Promise<CodexPortObservation>;
  /** Independent reviewer fetches/checks original artifact and provider receipts. */
  readonly review: (taskId: string, receipt: CodexDispatchReceipt, view: MissionView) =>
    Promise<VerifiedTaskResult | null>;
  /** Persist verified outcome in the EXISTING invocation journal before Native task.done. */
  readonly settle: (taskId: string, receipt: CodexDispatchReceipt, qa: VerifiedTaskResult) =>
    Promise<boolean>;
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
  if (view.record.state !== 'running') return result('blocked', 'not-running');

  for (let i = 0; i < options.maxTasks; i++) {
    view = read()!;
    const [taskId] = readyTaskIdsFromMission(view, 1);
    if (!taskId) break;
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
    if (!qa || qa.accepted !== true || !SHA256.test(qa.artifactDigest) ||
        !ID.test(qa.evidenceId) || !ID.test(qa.reviewerRunId) ||
        qa.reviewerRunId === receipt.invocationId) {
      await write(options.cycleId + ':' + taskId + ':qa-unknown', 'task.observed', {
        taskId, status: 'unknown', leaseEpoch: view.lease.epoch,
        invocationId: receipt.invocationId,
      });
      return result('blocked', 'qa-not-verified');
    }
    let settled = false;
    try { settled = await options.settle(taskId, receipt, qa); } catch { /* fail closed */ }
    if (!settled) return result('blocked', 'journal-settlement-unconfirmed');

    if (!await write(options.cycleId + ':' + taskId + ':done', 'task.observed', {
      taskId, status: 'recorded-done', leaseEpoch: view.lease.epoch,
      invocationId: receipt.invocationId,
    })) return result('blocked', 'native-task-observation-refused');

    const spec = view.planBody.tasks.find(task => task.id === taskId);
    for (const criterionId of spec?.acceptanceEvidence ?? []) {
      const criterion = view.planBody.acceptance.find(c => c.id === criterionId);
      if (!criterion || !await write(options.cycleId + ':' + taskId + ':qa:' + criterionId,
        'evidence.recorded', {
          evidenceId: qa.evidenceId + ':' + criterionId, criterionId, taskId,
          producer: criterion.producer, artifactDigest: qa.artifactDigest, verified: true,
        })) return result('blocked', 'native-independent-qa-refused');
    }
    done.push(taskId);
  }
  view = read()!;
  if (view.planBody?.tasks.some(t => view!.tasks[t.id]?.status !== 'recorded-done') ||
      view.unresolvedOperations.length) return result('partial', 'awaiting-more-accepted-ready');

  // All mandatory criteria must have authenticated evidence for ONE exact SHA.
  const mandatory = view.planBody.acceptance.filter(c => c.mandatory);
  const digest = view.evidence.find(e => e.verified && mandatory.some(c => c.id === e.criterionId))?.artifactDigest;
  if (!digest || !SHA256.test(digest) || !mandatory.every(c => view!.evidence.some(e =>
    e.criterionId === c.id && e.verified && e.artifactDigest === digest &&
    e.planRevision === view!.record.plan.revision &&
    e.criteriaDigest === view!.record.acceptance.criteriaDigest))) {
    return result('blocked', 'mandatory-qa-evidence-missing');
  }
  if (!await write(options.cycleId + ':settled', 'tasks.settled', {})) {
    return result('blocked', 'native-settlement-refused');
  }
  if (!await write(options.cycleId + ':terminal', 'acceptance.passed', { artifactDigest: digest })) {
    return result('blocked', 'native-terminal-refused');
  }
  return result('completed');
}
