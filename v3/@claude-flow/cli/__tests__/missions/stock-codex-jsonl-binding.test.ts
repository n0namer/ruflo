import { describe, expect, it } from 'vitest';
import { CodexDispatchBinding } from '../../src/missions/execution-dispatch-binding.js';
import type { CodexExecutorResult } from '../../src/missions/codex-executor.js';
import type { CodexDispatchRequest } from '../../src/missions/execution-dispatch-binding.js';

const physicalId = '01a15555-25de-7441-9da0-41f960be5da6';
const event = (type: string, fields: Record<string, unknown> = {}, line = 1) => ({
  line, raw: JSON.stringify({ type, ...fields }), value: { type, ...fields },
});

function fixture() {
  const request: CodexDispatchRequest = {
    prompt: 'Read-only Codex source fixture; no tools or writes',
    invocation: { missionId: 'msn_aaaaaaaaaaaaaaaaaaaaaaaa', taskId: 'inspect', invocationId: 'inv-1',
      threadId: 'logical-invocation-binding', missionEpoch: 1, planDigest: 'sha256:plan' },
    credential: { missionId: 'msn_aaaaaaaaaaaaaaaaaaaaaaaa', taskId: 'inspect', invocationId: 'inv-1',
      threadId: 'logical-invocation-binding', ownerId: 'owner', sessionId: 'session',
      authorizationRef: 'policy:approved', planDigest: 'sha256:plan', credential: 'trusted-fixture' },
    lease: { missionId: 'msn_aaaaaaaaaaaaaaaaaaaaaaaa', ownerId: 'owner', generation: '1',
      leaseId: 'lease-1', acquiredAt: 'now', expiresAt: 'later' },
  };
  const baseEvents = [
    event('thread.started', { thread_id: physicalId }),
    event('turn.started', {}, 2),
    event('turn.completed', {}, 3),
  ];
  let provenance = true;
  let observed = 0;
  let output: CodexExecutorResult | null = null;
  const binding = new CodexDispatchBinding({
    executor: {
      async run(execution) {
        observed++;
        return output ?? {
          outcome: 'completed', pid: 32342, exitCode: 0, signal: null, stdout: '',
          stderr: '', durationMs: 5, events: baseEvents, invalidJsonlLines: [],
          admission: execution.admission, settlement: 'observation-required', terminationConfirmed: true,
        };
      },
    },
    leaseStore: { async assertCurrent() {} },
    verifier: {
      verifyCredential: () => true,
      verifyInvocation: () => true,
      readMissionEpoch: () => 1,
      verifyPhysicalReceipt: () => provenance,
    },
  });
  const asResult = (events: typeof baseEvents, updates: Partial<CodexExecutorResult> = {}): CodexExecutorResult => ({
    outcome: 'completed', pid: 32342, exitCode: 0, signal: null, stdout: '', stderr: '',
    durationMs: 5, events, invalidJsonlLines: [], settlement: 'observation-required',
    terminationConfirmed: true,
    admission: { missionId: request.invocation.missionId, taskId: request.invocation.taskId,
      leaseEpoch: 1, authorizationRef: request.credential.authorizationRef,
      planDigest: request.invocation.planDigest }, ...updates,
  });
  return { request, binding, baseEvents, asResult,
    get observed() { return observed; }, setOutput(v: CodexExecutorResult) { output = v; },
    setProvenance(v: boolean) { provenance = v; } };
}
describe('stock Codex JSONL physical observations', () => {
  it('accepts the real CLI event schema only after independent provenance check', async () => {
    const f = fixture();
    const result = await f.binding.dispatch(f.request);
    expect(result).toMatchObject({ status: 'completed', pid: 32342,
      physicalThreadId: physicalId, settlement: 'observation-required' });
    expect(result.events.map(e => (e.value as Record<string, unknown>).type))
      .not.toContain('dispatch.receipt');
    expect(f.observed).toBe(1);
  });
  it('rejects an exit zero without thread.started or turn.completed', async () => {
    const f = fixture(); f.setOutput(f.asResult([event('turn.completed')]));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-missing' });
  });
  it('rejects duplicate/forged stock thread identity', async () => {
    const f = fixture();
    f.setOutput(f.asResult([event('thread.started', { thread_id: physicalId }),
      event('thread.started', { thread_id: physicalId }, 2), event('turn.completed', {}, 3)]));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-missing' });
  });
  it('rejects turn.failed even if turn.completed and exit code zero', async () => {
    const f = fixture();
    f.setOutput(f.asResult([...f.baseEvents, event('turn.failed', {}, 4)]));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-missing' });
  });
  it('does not accept physical JSONL when independent verification denies', async () => {
    const f = fixture(); f.setProvenance(false);
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-untrusted' });
  });
  it('rejects a mismatched mission admission even with a valid-looking Codex stream', async () => {
    const f = fixture();
    f.setOutput(f.asResult(f.baseEvents, { admission: {
      missionId: 'msn_wrong', taskId: 'inspect', leaseEpoch: 1,
      authorizationRef: 'policy:approved', planDigest: 'sha256:plan',
    } }));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-missing' });
  });
});

describe('legacy wrapped receipts remain physically fenced', () => {
  const wrapped = { type: 'dispatch.receipt', status: 'completed',
    missionId: 'msn_aaaaaaaaaaaaaaaaaaaaaaaa', taskId: 'inspect',
    invocationId: 'inv-1', threadId: 'logical-invocation-binding' };
  it('preserves the authenticated wrapped receipt pathway with a real PID', async () => {
    const f = fixture();
    f.setOutput(f.asResult([event('dispatch.receipt', wrapped)]));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'completed', pid: 32342, settlement: 'observation-required',
    });
  });
  it('rejects a wrapped completed claim without any physical PID', async () => {
    const f = fixture();
    f.setOutput(f.asResult([event('dispatch.receipt', wrapped)], { pid: null }));
    expect(await f.binding.dispatch(f.request)).toMatchObject({
      status: 'rejected', reason: 'physical-receipt-missing',
    });
  });
});
