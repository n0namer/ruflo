import { describe, expect, it } from 'vitest';
import { classifyExecutionRecovery, type RecoveryInput } from '../../src/missions/execution-recovery.js';

const admitted = {
  missionId: 'msn_stock',
  taskId: 'compile',
  invocationId: 'invoke-7',
  executorId: 'worker-a',
  leaseEpoch: 3,
  admitted: true as const,
  authorizationRef: 'auth:stock:3',
};

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    worker: admitted,
    observation: { status: 'running', heartbeat: 'expired' },
    dispatches: [],
    ...overrides,
  };
}

describe('classifyExecutionRecovery', () => {
  it('requests one recovery dispatch for an admitted worker after a crash', () => {
    const decision = classifyExecutionRecovery(input());
    expect(decision).toEqual({
      kind: 'dispatch',
      reason: 'heartbeat-expired',
      recoveryKey: 'mission-recovery:msn_stock:compile:invoke-7:3',
      duplicate: false,
    });
  });

  it('keeps UNKNOWN heartbeat distinct from expired and recoverable', () => {
    const decision = classifyExecutionRecovery(input({
      observation: { status: 'unknown', heartbeat: 'unknown', exitCode: 1 },
    }));
    expect(decision).toMatchObject({ kind: 'dispatch', reason: 'heartbeat-unknown' });
    expect(decision).not.toMatchObject({ kind: 'failed' });
  });

  it('does not dispatch twice when a durable reservation exists after restart', () => {
    const first = classifyExecutionRecovery(input());
    if (first.kind !== 'dispatch') throw new Error('expected dispatch intent');
    const restarted = classifyExecutionRecovery(input({
      dispatches: [{
        recoveryKey: first.recoveryKey,
        status: 'reserved',
        invocationId: admitted.invocationId,
        leaseEpoch: admitted.leaseEpoch,
      }],
    }));
    expect(restarted).toEqual({
      kind: 'awaiting-reconciliation',
      reason: 'heartbeat-expired',
      recoveryKey: first.recoveryKey,
      duplicate: true,
    });
  });

  it('also suppresses duplicates from an older persisted key for the same invocation epoch', () => {
    expect(classifyExecutionRecovery(input({
      dispatches: [{
        recoveryKey: 'legacy-recovery-key',
        status: 'dispatched',
        invocationId: admitted.invocationId,
        leaseEpoch: admitted.leaseEpoch,
      }],
    })).kind).toBe('awaiting-reconciliation');
  });

  it('does not redispatch a recovery that was durably settled', () => {
    for (const status of ['completed', 'failed'] as const) {
      expect(classifyExecutionRecovery(input({
        dispatches: [{
          recoveryKey: 'settled-recovery',
          status,
          invocationId: admitted.invocationId,
          leaseEpoch: admitted.leaseEpoch,
        }],
      }))).toEqual({ kind: 'noop', reason: 'recovery-already-settled' });
    }
  });

  it('requires verified evidence before classifying FAILED', () => {
    expect(classifyExecutionRecovery(input({
      observation: { status: 'failed', heartbeat: 'unknown', exitCode: 137 },
    }))).toMatchObject({ kind: 'dispatch', reason: 'heartbeat-unknown' });

    expect(classifyExecutionRecovery(input({
      observation: {
        status: 'failed',
        heartbeat: 'healthy',
        exitCode: 1,
        failure: { verified: true, evidenceRef: 'evidence:crash', cause: 'runtime-error' },
      },
    }))).toEqual({
      kind: 'failed',
      reason: 'verified-failure',
      evidenceRef: 'evidence:crash',
      cause: 'runtime-error',
    });
  });

  it('does not recover work that was never admitted', () => {
    expect(classifyExecutionRecovery(input({ worker: null }))).toEqual({
      kind: 'ineligible',
      reason: 'not-admitted',
    });
  });

  it('rejects malformed persisted observations without throwing', () => {
    expect(classifyExecutionRecovery({
      ...input(),
      observation: undefined,
    } as unknown as RecoveryInput)).toEqual({
      kind: 'ineligible',
      reason: 'invalid-admission',
    });
  });

  it('does not dispatch a healthy or already succeeded worker', () => {
    expect(classifyExecutionRecovery(input({
      observation: { status: 'running', heartbeat: 'healthy' },
    })).kind).toBe('noop');
    expect(classifyExecutionRecovery(input({
      observation: { status: 'succeeded', heartbeat: 'unknown', exitCode: 0 },
    })).kind).toBe('noop');
  });

  it('rejects malformed admission instead of bypassing authorization', () => {
    expect(classifyExecutionRecovery(input({
      worker: { ...admitted, authorizationRef: '' },
    }))).toEqual({ kind: 'ineligible', reason: 'invalid-admission' });
    expect(classifyExecutionRecovery(input({
      worker: { ...admitted, leaseEpoch: 0 },
    }))).toEqual({ kind: 'ineligible', reason: 'invalid-admission' });
  });
});
