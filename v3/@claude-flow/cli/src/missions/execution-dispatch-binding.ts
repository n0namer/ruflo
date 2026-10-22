/**
 * Stock M2 Codex dispatch binding.
 *
 * This composes the existing process adapter with trusted invocation and
 * lease/epoch checks. It does not enqueue, settle, or mutate mission state.
 */
import type {
  CodexExecutor,
  CodexExecutorResult,
} from './codex-executor.js';
import type { ExecutionLease, ExecutionLeaseStore } from './execution-lease.js';

export interface MissionInvocation {
  readonly missionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly missionEpoch: number;
  readonly planDigest: string;
}

export interface TrustedDispatchCredential {
  readonly missionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly authorizationRef: string;
  readonly planDigest: string;
  readonly credential: string;
}

export interface CodexDispatchRequest {
  readonly prompt: string;
  readonly invocation: MissionInvocation;
  readonly credential: TrustedDispatchCredential;
  readonly lease: ExecutionLease;
  readonly timeoutMs?: number;
}

export type CodexDispatchRejection =
  | 'invalid-input'
  | 'credential-denied'
  | 'credential-mismatch'
  | 'invocation-denied'
  | 'invocation-mismatch'
  | 'stale-admission'
  | 'physical-receipt-missing'
  | 'physical-receipt-untrusted';

export type CodexDispatchStatus = 'completed' | 'failed' | 'unknown' | 'rejected';

export interface CodexDispatchReceipt {
  readonly status: CodexDispatchStatus;
  readonly missionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly pid: number | null;
  readonly outcome: CodexExecutorResult['outcome'] | null;
  readonly exitCode: number | null;
  readonly events: ReadonlyArray<CodexExecutorResult['events'][number]>;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: CodexDispatchRejection | 'ambiguous-timeout' | 'worker-failed' | 'reconciliation-required';
  readonly settlement: 'observation-required';
}

export interface CodexDispatchVerifier {
  readonly verifyCredential: (credential: TrustedDispatchCredential) => boolean | Promise<boolean>;
  readonly verifyInvocation: (invocation: MissionInvocation) => boolean | Promise<boolean>;
  /** Independent trusted provenance check; worker stdout alone is not authority. */
  readonly verifyPhysicalReceipt: (
    result: CodexExecutorResult,
    request: CodexDispatchRequest,
  ) => boolean | Promise<boolean>;
  readonly readMissionEpoch: (missionId: string) => number | Promise<number>;
}

export interface CodexDispatchBindingOptions {
  readonly executor: Pick<CodexExecutor, 'run'>;
  readonly leaseStore: Pick<ExecutionLeaseStore, 'assertCurrent'>;
  readonly verifier: CodexDispatchVerifier;
}

function required(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
}

function validInvocation(invocation: MissionInvocation): void {
  if (!invocation || typeof invocation !== 'object') throw new TypeError('invocation is required');
  for (const [value, name] of [
    [invocation.missionId, 'invocation.missionId'],
    [invocation.taskId, 'invocation.taskId'],
    [invocation.invocationId, 'invocation.invocationId'],
    [invocation.threadId, 'invocation.threadId'],
    [invocation.planDigest, 'invocation.planDigest'],
  ] as const) required(value, name);
  if (!Number.isSafeInteger(invocation.missionEpoch) || invocation.missionEpoch < 0) {
    throw new TypeError('invocation.missionEpoch must be a non-negative integer');
  }
}

function validCredential(credential: TrustedDispatchCredential): void {
  if (!credential || typeof credential !== 'object') throw new TypeError('credential is required');
  for (const [value, name] of [
    [credential.missionId, 'credential.missionId'],
    [credential.taskId, 'credential.taskId'],
    [credential.invocationId, 'credential.invocationId'],
    [credential.ownerId, 'credential.ownerId'],
    [credential.sessionId, 'credential.sessionId'],
    [credential.threadId, 'credential.threadId'],
    [credential.authorizationRef, 'credential.authorizationRef'],
    [credential.planDigest, 'credential.planDigest'],
    [credential.credential, 'credential.credential'],
  ] as const) required(value, name);
}

function sameBinding(request: CodexDispatchRequest): boolean {
  const { invocation, credential, lease } = request;
  return credential.missionId === invocation.missionId
    && credential.taskId === invocation.taskId
    && credential.invocationId === invocation.invocationId
    && credential.threadId === invocation.threadId
    && credential.planDigest === invocation.planDigest
    && credential.ownerId === lease.ownerId
    && lease.missionId === invocation.missionId
    && lease.generation === String(invocation.missionEpoch);
}

function physicalReceipt(result: CodexExecutorResult, request: CodexDispatchRequest): boolean {
  const admission = result.admission;
  if (
    admission.missionId !== request.invocation.missionId
    || admission.taskId !== request.invocation.taskId
    || admission.leaseEpoch !== request.invocation.missionEpoch
    || admission.authorizationRef !== request.credential.authorizationRef
    || admission.planDigest !== request.invocation.planDigest
  ) {
    return false;
  }
  return result.events.some(({ value }) => {
    if (!value || typeof value !== 'object') return false;
    const event = value as Record<string, unknown>;
    return event.type === 'dispatch.receipt'
      && event.status === 'completed'
      && event.missionId === request.invocation.missionId
      && event.taskId === request.invocation.taskId
      && event.invocationId === request.invocation.invocationId
      && event.threadId === request.invocation.threadId;
  });
}

function receipt(
  request: CodexDispatchRequest,
  result: CodexExecutorResult | null,
  status: CodexDispatchStatus,
  reason?: CodexDispatchReceipt['reason'],
): CodexDispatchReceipt {
  return {
    status,
    missionId: request.invocation.missionId,
    taskId: request.invocation.taskId,
    invocationId: request.invocation.invocationId,
    threadId: request.invocation.threadId,
    pid: result?.pid ?? null,
    outcome: result?.outcome ?? null,
    exitCode: result?.exitCode ?? null,
    events: result?.events ?? [],
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    ...(reason ? { reason } : {}),
    settlement: 'observation-required',
  };
}

export class CodexDispatchBinding {
  private readonly executor: Pick<CodexExecutor, 'run'>;
  private readonly leaseStore: Pick<ExecutionLeaseStore, 'assertCurrent'>;
  private readonly verifier: CodexDispatchVerifier;

  constructor(options: CodexDispatchBindingOptions) {
    this.executor = options.executor;
    this.leaseStore = options.leaseStore;
    this.verifier = options.verifier;
  }

  async dispatch(request: CodexDispatchRequest): Promise<CodexDispatchReceipt> {
    if (!request || typeof request.prompt !== 'string' || request.prompt.trim() === '') {
      throw new TypeError('prompt is required');
    }
    validInvocation(request.invocation);
    validCredential(request.credential);

    if (!sameBinding(request)) {
      return receipt(request, null, 'rejected', 'credential-mismatch');
    }
    if (!(await this.verifier.verifyCredential(request.credential))) {
      return receipt(request, null, 'rejected', 'credential-denied');
    }
    if (!(await this.verifier.verifyInvocation(request.invocation))) {
      return receipt(request, null, 'rejected', 'invocation-denied');
    }

    try {
      await this.leaseStore.assertCurrent(request.lease);
      const currentEpoch = await this.verifier.readMissionEpoch(request.invocation.missionId);
      if (currentEpoch !== request.invocation.missionEpoch) {
        return receipt(request, null, 'rejected', 'stale-admission');
      }
    } catch {
      return receipt(request, null, 'rejected', 'stale-admission');
    }

    let result: CodexExecutorResult;
    try {
      result = await this.executor.run({
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        admission: {
          missionId: request.invocation.missionId,
          taskId: request.invocation.taskId,
          leaseEpoch: request.invocation.missionEpoch,
          authorizationRef: request.credential.authorizationRef,
          planDigest: request.invocation.planDigest,
        },
      });
    } catch {
      // The process may have started before the adapter reported an error.
      return receipt(request, null, 'unknown', 'reconciliation-required');
    }

    if (result.outcome === 'timed-out' || !result.terminationConfirmed) {
      return receipt(request, result, 'unknown', 'ambiguous-timeout');
    }
    if (result.outcome !== 'completed') {
      return receipt(request, result, 'failed', 'worker-failed');
    }
    if (!physicalReceipt(result, request)) {
      return receipt(request, result, 'rejected', 'physical-receipt-missing');
    }
    let provenanceVerified: boolean;
    try {
      provenanceVerified = await this.verifier.verifyPhysicalReceipt(result, request);
    } catch {
      return receipt(request, result, 'unknown', 'reconciliation-required');
    }
    if (!provenanceVerified) {
      return receipt(request, result, 'rejected', 'physical-receipt-untrusted');
    }
    return receipt(request, result, 'completed');
  }
}

/** Functional facade for callers that do not need to retain the binding. */
export async function dispatchCodexMission(
  request: CodexDispatchRequest,
  options: CodexDispatchBindingOptions,
): Promise<CodexDispatchReceipt> {
  return new CodexDispatchBinding(options).dispatch(request);
}
