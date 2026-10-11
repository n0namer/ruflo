/**
 * Durable restart recovery for admitted stock mission workers.
 *
 * This module only classifies a recovery observation. It does not authorize
 * admission, settle a mission, or dispatch a worker. Callers persist the
 * returned recoveryKey/dispatch record before performing any dispatch.
 *
 * A lost heartbeat is an observation, not proof of failure. In particular,
 * process exit codes and stale owner metadata cannot create a terminal result.
 */

export type RecoveryHeartbeat = 'healthy' | 'expired' | 'unknown';
export type RecoveryWorkerStatus = 'running' | 'succeeded' | 'failed' | 'unknown';
export type RecoveryDispatchStatus = 'reserved' | 'dispatched' | 'acknowledged' | 'completed' | 'failed';

export interface AdmittedWorker {
  readonly missionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly executorId: string;
  readonly leaseEpoch: number;
  /** Admission is explicit and must carry the policy/authorization reference. */
  readonly admitted: true;
  readonly authorizationRef: string;
}

export interface WorkerObservation {
  readonly status: RecoveryWorkerStatus;
  readonly heartbeat: RecoveryHeartbeat;
  /** Exit status is diagnostic only; it is never terminal authority. */
  readonly exitCode?: number;
  readonly failure?: {
    readonly verified: true;
    readonly evidenceRef: string;
    readonly cause: string;
  };
}

export interface RecoveryDispatchRecord {
  readonly recoveryKey: string;
  readonly status: RecoveryDispatchStatus;
  readonly invocationId: string;
  readonly leaseEpoch: number;
}

export interface RecoveryInput {
  readonly worker: AdmittedWorker | null;
  readonly observation: WorkerObservation;
  readonly dispatches: readonly RecoveryDispatchRecord[];
}

export type RecoveryDecision =
  | {
      readonly kind: 'dispatch';
      readonly reason: 'heartbeat-expired' | 'heartbeat-unknown';
      readonly recoveryKey: string;
      readonly duplicate: false;
    }
  | {
      readonly kind: 'awaiting-reconciliation';
      readonly reason: 'heartbeat-expired' | 'heartbeat-unknown';
      readonly recoveryKey: string;
      readonly duplicate: true;
    }
  | {
      readonly kind: 'failed';
      readonly reason: 'verified-failure';
      readonly evidenceRef: string;
      readonly cause: string;
    }
  | {
      readonly kind: 'noop';
      readonly reason: 'heartbeat-healthy' | 'worker-succeeded' | 'recovery-already-settled';
    }
  | {
      readonly kind: 'ineligible';
      readonly reason: 'not-admitted' | 'invalid-admission';
    };

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function recoveryKey(worker: AdmittedWorker): string {
  return [
    'mission-recovery',
    worker.missionId,
    worker.taskId,
    worker.invocationId,
    String(worker.leaseEpoch),
  ].join(':');
}

function existingRecoveryStatus(
  worker: AdmittedWorker,
  key: string,
  dispatches: readonly RecoveryDispatchRecord[],
): RecoveryDispatchStatus | undefined {
  return dispatches.find((dispatch) => (
    dispatch.recoveryKey === key
    || (
      dispatch.invocationId === worker.invocationId
      && dispatch.leaseEpoch === worker.leaseEpoch
    )
  ))?.status;
}

/**
 * Classify one durable restart observation.
 *
 * The returned "dispatch" is an intent only. A durable caller must record the
 * key atomically with its dispatch reservation and re-run this classifier from
 * persisted state after a crash. Any existing record for the same invocation
 * and lease epoch suppresses a second dispatch.
 */
export function classifyExecutionRecovery(input: RecoveryInput): RecoveryDecision {
  const worker = input.worker;
  if (!worker || worker.admitted !== true) {
    return { kind: 'ineligible', reason: 'not-admitted' };
  }
  if (
    !validText(worker.missionId)
    || !validText(worker.taskId)
    || !validText(worker.invocationId)
    || !validText(worker.executorId)
    || !Number.isInteger(worker.leaseEpoch)
    || worker.leaseEpoch < 1
    || !validText(worker.authorizationRef)
  ) {
    return { kind: 'ineligible', reason: 'invalid-admission' };
  }

  const observation = input?.observation;
  if (!observation || typeof observation !== 'object') {
    return { kind: 'ineligible', reason: 'invalid-admission' };
  }
  if (
    worker.leaseEpoch !== Math.trunc(worker.leaseEpoch)
    || !['running', 'succeeded', 'failed', 'unknown'].includes(observation.status)
    || !['healthy', 'expired', 'unknown'].includes(observation.heartbeat)
  ) {
    return { kind: 'ineligible', reason: 'invalid-admission' };
  }

  if (
    observation.status === 'failed'
    && observation.failure?.verified === true
    && validText(observation.failure.evidenceRef)
    && validText(observation.failure.cause)
  ) {
    return {
      kind: 'failed',
      reason: 'verified-failure',
      evidenceRef: observation.failure.evidenceRef,
      cause: observation.failure.cause,
    };
  }

  if (observation.status === 'succeeded') {
    return { kind: 'noop', reason: 'worker-succeeded' };
  }

  if (observation.heartbeat === 'healthy') {
    return { kind: 'noop', reason: 'heartbeat-healthy' };
  }

  const reason = observation.heartbeat === 'expired'
    ? 'heartbeat-expired'
    : 'heartbeat-unknown';
  const key = recoveryKey(worker);
  const existingStatus = existingRecoveryStatus(worker, key, input.dispatches);
  if (existingStatus === 'completed' || existingStatus === 'failed') {
    return { kind: 'noop', reason: 'recovery-already-settled' };
  }
  if (existingStatus !== undefined) {
    return { kind: 'awaiting-reconciliation', reason, recoveryKey: key, duplicate: true };
  }

  return { kind: 'dispatch', reason, recoveryKey: key, duplicate: false };
}
