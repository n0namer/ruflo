import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MissionService, type NativeRuntimeEventType, type NativeEventProof } from '../../src/missions/service.js';
import { plan } from './helpers.js';

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'ruflo-native-terminal-')); });
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
function service(allowQA = true, channel: 'cli' | 'internal' = 'internal') {
  return new MissionService({
    projectRoot, channel,
    executionAdmission: (view, action) => {
      const root = projectRoot.replace(/\\/g, '/');
      return {
        action, worktree: { rooted: true, root, candidate: root, repositoryId: 'test-repo', sourceStateId: sha('source') },
        policy: { allowed: true, decisionRef: 'policy:fixture' },
        budget: { allowed: true, reservationRef: 'budget:fixture',
          estimatedMinor: view.budget!.estimatedMinor,
          remainingMinor: view.budget!.ceilingMinor - view.budget!.reservedMinor - view.budget!.settledMinor - view.budget!.unresolvedMinor },
        permissions: { granted: true, required: ['fs.write'], explicit: ['fs.write'], authorizationRef: 'auth:fixture' },
        evidenceRefs: ['worktree:fixture', 'policy:fixture', 'budget:fixture', 'permission:fixture'],
      };
    },
    authorizeRuntimeEvent: (_view, kind: NativeRuntimeEventType) => {
      const authorized: NativeEventProof = { authorized: true, receiptRef: 'native:verified',
        ...(kind === 'evidence.recorded' && allowQA ? { independentQa: true as const } : {}) };
      return authorized;
    },
  });
}
async function prepared(s: MissionService) {
  const created = await s.create({ requestId: 'new', objective: 'Native executor lifecycle test' });
  if (!created.ok) throw new Error(created.message);
  const missionId = created.data.missionId;
  const planned = await s.plan({ requestId: 'plan', missionId, expectedRevision: 1, plan: plan() });
  if (!planned.ok) throw new Error(planned.message);
  const admitted = await s.requestAction({ requestId: 'admit', missionId, expectedRevision: 2, action: 'admit' });
  if (!admitted.ok) throw new Error(admitted.message);
  return missionId;
}
async function runtime(s: MissionService, missionId: string, id: string, revision: number,
                       type: NativeRuntimeEventType, payload: Record<string, unknown>) {
  return s.recordNativeEvent({ requestId: id, missionId, expectedRevision: revision, type, payload });
}
describe('stock MissionStore trusted Native terminal ingress', () => {
  it('records physically observed tasks and QA receipts before immutable terminal', async () => {
    const s = service();
    const missionId = await prepared(s);
    expect(await runtime(s, missionId, 'ack', 3, 'executor.acknowledged',
      { executorId: 'codex-1', leaseEpoch: 1 })).toMatchObject({ ok: true, data: { state: 'running', revision: 4 } });
    const artifact = sha('artifact-1');
    for (const id of ['produce', 'evaluate', 'verify']) {
      expect(await runtime(s, missionId, 'task-' + id, 4, 'task.observed',
        { taskId: id, status: 'recorded-done', leaseEpoch: 1, invocationId: 'inv-' + id }))
        .toMatchObject({ ok: true, data: { state: 'running', revision: 4 } });
    }
    expect(await runtime(s, missionId, 'evidence', 4, 'evidence.recorded',
      { evidenceId: 'qa-1', criterionId: 'quality', producer: 'metaharness',
        taskId: 'evaluate', artifactDigest: artifact, verified: true }))
      .toMatchObject({ ok: true });
    expect(await runtime(s, missionId, 'settle', 4, 'tasks.settled', {}))
      .toMatchObject({ ok: true, data: { state: 'verifying', revision: 5 } });
    expect(await runtime(s, missionId, 'accept', 5, 'acceptance.passed', { artifactDigest: artifact }))
      .toMatchObject({ ok: true, data: { state: 'completed', revision: 6 } });
    expect(await runtime(s, missionId, 'accept', 5, 'acceptance.passed', { artifactDigest: artifact }))
      .toMatchObject({ ok: true, data: { deduplicated: true } });
    expect(await runtime(s, missionId, 'late', 6, 'task.observed',
      { taskId: 'verify', status: 'recorded-done', leaseEpoch: 1 }))
      .toMatchObject({ ok: false, code: 'terminal' });
  });
  it('denies forged/unverified QA and never silently settles Mission', async () => {
    const s = service(false);
    const missionId = await prepared(s);
    expect(await runtime(s, missionId, 'ack', 3, 'executor.acknowledged',
      { executorId: 'codex-1', leaseEpoch: 1 })).toMatchObject({ ok: true });
    expect(await runtime(s, missionId, 'fake-qa', 4, 'evidence.recorded',
      { evidenceId: 'unverified', criterionId: 'quality', producer: 'metaharness',
        artifactDigest: sha('fake'), verified: true }))
      .toMatchObject({ ok: false, code: 'admission-denied' });
    expect(await s.get({ missionId })).toMatchObject({ ok: true, data: { record: { state: 'running', revision: 4 } } });
  });
  it('refuses Native event recording from a normal CLI service and stale epochs', async () => {
    const runtimeSvc = service();
    const missionId = await prepared(runtimeSvc);
    expect(await runtime(service(true, 'cli'), missionId, 'forged', 3, 'executor.acknowledged',
      { executorId: 'other', leaseEpoch: 1 })).toMatchObject({ ok: false, code: 'executor-unavailable' });
    expect(await runtime(runtimeSvc, missionId, 'stale', 3, 'executor.acknowledged',
      { executorId: 'codex-1', leaseEpoch: 0 })).toMatchObject({ ok: false, code: 'guard-failed' });
    expect(await runtimeSvc.get({ missionId })).toMatchObject({ ok: true, data: { record: { state: 'queued', revision: 3 } } });
  });
});
