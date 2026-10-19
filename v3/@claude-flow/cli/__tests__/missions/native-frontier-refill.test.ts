import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { readyTaskIdsFromMission } from '../../src/missions/execution-frontier.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-native-refill-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const admission = (view: any, action: 'admit' | 'resume') => {
  const rootPath = root.replace(/\\/g, '/');
  return { action, worktree: { rooted: true, root: rootPath, candidate: rootPath,
      repositoryId: 'test-repo', sourceStateId: 'fixture' },
    policy: { allowed: true, decisionRef: 'policy:verified-fixture' },
    budget: { allowed: true, reservationRef: 'budget:fixture', estimatedMinor: view.budget.estimatedMinor,
      remainingMinor: view.budget.ceilingMinor - view.budget.reservedMinor -
        view.budget.settledMinor - view.budget.unresolvedMinor },
    permissions: { granted: true, required: ['fs.write'], explicit: ['fs.write'],
      authorizationRef: 'auth:fixture' },
    evidenceRefs: ['worktree:receipt', 'policy:receipt', 'budget:receipt', 'permission:receipt'] };
};
describe('affected-only READY refill over stock MissionStore DAG', () => {
  it('advances without another scheduler and blocks unknown worker outcomes', async () => {
    const svc = new MissionService({ projectRoot: root, channel: 'internal',
      executionAdmission: admission,
      authorizeRuntimeEvent: () => ({ authorized: true, receiptRef: 'stock:attested' }),
    });
    const created = await svc.create({ requestId: 'new', objective: 'Three-step Native MVP cycle' });
    if (!created.ok) throw Error(created.message);
    const missionId = created.data.missionId;
    const p = await svc.plan({ requestId: 'plan', missionId, expectedRevision: 1, plan: plan() });
    if (!p.ok) throw Error(p.message);
    expect(readyTaskIdsFromMission(new MissionStore(root).loadView(missionId)!)).toEqual([]);
    const admitted = await svc.requestAction({ requestId: 'admit', missionId,
      expectedRevision: 2, action: 'admit' });
    expect(admitted).toMatchObject({ ok: true });
    const ready = () => readyTaskIdsFromMission(new MissionStore(root).loadView(missionId)!);
    expect(ready()).toEqual(['produce']);
    expect(await svc.recordNativeEvent({ requestId: 'ack', missionId, expectedRevision: 3,
      type: 'executor.acknowledged', payload: { executorId: 'codex-1', leaseEpoch: 1 } }))
      .toMatchObject({ ok: true });
    expect(ready()).toEqual(['produce']);
    expect(await svc.recordNativeEvent({ requestId: 'produce', missionId, expectedRevision: 4,
      type: 'task.observed', payload: { taskId: 'produce', status: 'recorded-done', leaseEpoch: 1 } }))
      .toMatchObject({ ok: true });
    expect(ready()).toEqual(['evaluate']);
    expect(await svc.recordNativeEvent({ requestId: 'evaluate', missionId, expectedRevision: 4,
      type: 'task.observed', payload: { taskId: 'evaluate', status: 'recorded-done', leaseEpoch: 1 } }))
      .toMatchObject({ ok: true });
    expect(ready()).toEqual(['verify']);
    expect(await svc.recordNativeEvent({ requestId: 'unknown', missionId, expectedRevision: 4,
      type: 'task.observed', payload: { taskId: 'verify', status: 'unknown', leaseEpoch: 1 } }))
      .toMatchObject({ ok: true });
    expect(ready()).toEqual([]);
    expect(await svc.recordNativeEvent({ requestId: 'stale', missionId, expectedRevision: 4,
      type: 'task.observed', payload: { taskId: 'verify', status: 'recorded-done', leaseEpoch: 0 } }))
      .toMatchObject({ ok: false, code: 'stale-epoch' });
    expect(ready()).toEqual([]);
  });
});
