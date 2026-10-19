import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CodexMissionPort, codexPortInputDigest } from '../../src/missions/execution-m2-r7-codex-port.js';
import type { CodexExecutorResult } from '../../src/missions/codex-executor.js';

const digest = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const uuid = '01a15555-25de-7441-9da0-41f960be5da6';
const event = (type: string, body: Record<string, unknown> = {}, line = 1) =>
  ({ line, raw: JSON.stringify({ type, ...body }), value: { type, ...body } });

function fixture() {
  const id = 'msn_aaaaaaaaaaaaaaaaaaaaaaaa';
  const prompt = 'Inspect only the isolated authorized file';
  const planDigest = digest('plan');
  const sourceDigest = digest('source');
  const policyDigest = digest('policy');
  const dispatch = {
    prompt, invocation: { missionId: id, taskId: 'inspect', invocationId: 'inv-1',
      threadId: 'logical-thread', missionEpoch: 1, planDigest },
    credential: { missionId: id, taskId: 'inspect', invocationId: 'inv-1',
      threadId: 'logical-thread', ownerId: 'owner', sessionId: 'session',
      authorizationRef: 'policy:authenticated', planDigest, credential: 'trusted-test-only' },
    lease: { missionId: id, ownerId: 'owner', generation: '1',
      leaseId: 'lease-1', acquiredAt: '2026-10-19T00:00:00.000Z',
      expiresAt: '2026-10-20T00:00:00.000Z' },
  };
  const intent = {
    missionId: id, taskId: 'inspect', invocationId: 'inv-1', planRevision: 1,
    leaseGeneration: '1', ownerId: 'owner', sessionId: 'session',
    policyRef: 'policy', policyDigest, sourceDigest, inputDigest: codexPortInputDigest(dispatch),
    authority: { decisionRef: 'policy:authenticated', policyDigest },
  };
  const effect = {
    effectId: 'inv-1', permission: { granted: true, authenticated: true,
      capability: 'codex.execute', authorizationRef: 'policy:authenticated' },
    scope: { root: 'C:/authorized', resource: 'C:/authorized/readme.txt' },
    fence: { missionId: id, leaseId: 'lease-1', generation: '1', revision: 1 },
  };
  let accepted = true;
  let executed = 0;
  let stream = [event('thread.started', { thread_id: uuid }), event('turn.completed', {}, 2)];
  const options = {
    dispatch: {
      executor: { async run(admissionRequest: { admission: CodexExecutorResult['admission'] }) {
        executed++;
        return {
          outcome: 'completed' as const, pid: 40120, exitCode: 0, signal: null,
          stdout: '', stderr: '', events: stream, invalidJsonlLines: [], durationMs: 2,
          terminationConfirmed: true, settlement: 'observation-required' as const,
          admission: admissionRequest.admission,
        };
      } },
      leaseStore: { async assertCurrent() {} },
      verifier: { async verifyCredential() { return true; }, async verifyInvocation() { return true; },
        async readMissionEpoch() { return 1; },
        async verifyPhysicalReceipt() { return accepted; } },
    },
    journal: {
      async prepare(given: typeof intent) {
        return { ...given, status: 'prepared' as const, preparedAt: '2026-10-19T00:00:00.000Z' };
      },
      async markDispatched(given: typeof intent, dispatchRef: string) {
        return { ...given, status: 'dispatched' as const, dispatchRef,
          preparedAt: '2026-10-19T00:00:00.000Z', dispatchedAt: '2026-10-19T00:00:00.100Z' };
      },
    },
    readEffect: () => effect,
    readSourceDigest: () => sourceDigest,
  };
  const port = new CodexMissionPort(options);
  return { port, input: { dispatch, intent, effect }, get executed() { return executed; },
    denyQa() { accepted = false; }, failStream() { stream = [...stream, event('turn.failed', {}, 3)]; },
    missingThread() { stream = [event('turn.completed')]; } };
}

describe('real stock Codex JSONL through existing M2 CodexMissionPort', () => {
  it('records one physical observation with independent verification still required', async () => {
    const f = fixture();
    const result = await f.port.dispatch(f.input);
    expect(result).toMatchObject({ status: 'observed', reason: 'process-observed-independent-qa-required',
      settlement: 'observation-required' });
    expect(result.receipt).toMatchObject({ pid: 40120, physicalThreadId: uuid, status: 'completed' });
    expect(f.executed).toBe(1);
  });
  it('rejects a missing stock thread despite turn completion', async () => {
    const f = fixture(); f.missingThread();
    expect(await f.port.dispatch(f.input)).toMatchObject({ status: 'rejected' });
  });
  it('rejects completed+failed turns and never accepts the stdout alone', async () => {
    const f = fixture(); f.failStream();
    expect(await f.port.dispatch(f.input)).toMatchObject({ status: 'rejected' });
  });
  it('rejects a real-looking stock stream when independent provenance denies', async () => {
    const f = fixture(); f.denyQa();
    expect(await f.port.dispatch(f.input)).toMatchObject({ status: 'rejected' });
  });
});
