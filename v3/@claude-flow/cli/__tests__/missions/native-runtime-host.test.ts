import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionService, type MissionView } from '../../src/missions/index.js';
import { createMissionTools } from '../../src/mcp-tools/mission-tools.js';
import { missionCommand } from '../../src/commands/mission.js';
import { nativeMissionService, installNativeMissionHost } from '../../src/missions/native-runtime-host.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-native-host-')); });
afterEach(() => { installNativeMissionHost(null); rmSync(root, { recursive: true, force: true }); });

function authority(view: MissionView, action: 'admit' | 'resume') {
  const remaining = view.budget!.ceilingMinor - view.budget!.reservedMinor - view.budget!.settledMinor - view.budget!.unresolvedMinor;
  const canonical = root.replace(/\\/g, '/');
  return {
    action,
    worktree: { rooted: true, root: canonical, candidate: canonical, repositoryId: 'fixture',
      sourceStateId: 'fixture-sha', canonicalRoot: canonical, canonicalCandidate: canonical },
    policy: { allowed: true, decisionRef: 'policy:verified-fixture' },
    budget: { allowed: true, reservationRef: 'budget:verified-fixture', remainingMinor: remaining,
      estimatedMinor: view.budget!.estimatedMinor },
    permissions: { granted: true, required: ['fs.write'], explicit: ['fs.write'],
      authorizationRef: 'auth:verified-fixture' },
    evidenceRefs: ['worktree:receipt', 'policy:receipt', 'budget:receipt', 'permissions:receipt'],
  };
}
async function prepare() {
  const s = new MissionService({ projectRoot: root, channel: 'cli' });
  const created = await s.create({ requestId: 'created', objective: 'Verify existing Native Mission admission' });
  if (!created.ok) throw Error(created.message);
  const planned = await s.plan({ requestId: 'planned', missionId: created.data.missionId, expectedRevision: 1, plan: plan() });
  if (!planned.ok) throw Error(planned.message);
  return created.data.missionId;
}
async function action(missionId: string, requestId = 'admit', expectedRevision = 2) {
  const t = createMissionTools().find(t => t.name === 'mission_request_action')!;
  return t.handler({ requestId, missionId, expectedRevision, action: 'admit' }, { projectRoot: root });
}
describe('Native Mission host shared CLI/MCP seam', () => {
  it('refuses admission when host is unconfigured, even with untrusted claims', async () => {
    const missionId = await prepare();
    expect(await action(missionId)).toMatchObject({ ok: false, code: 'executor-unavailable' });
    expect(await nativeMissionService(root, 'cli').requestAction({
      requestId: 'forged', missionId, expectedRevision: 2, action: 'admit',
      permissions: { granted: true }, executorReady: true,
    })).toMatchObject({ ok: false, code: 'invalid-input' });
  });
  it('both clients use the same host and deduplicate the same request', async () => {
    const missionId = await prepare();
    let calls = 0;
    installNativeMissionHost({ durableExecutorReady: () => true,
      executionAdmission: (view, kind) => { calls++; return authority(view, kind); } });
    expect(await action(missionId)).toMatchObject({ ok: true, data: { state: 'queued', revision: 3 } });
    expect(await nativeMissionService(root, 'cli').requestAction({
      requestId: 'admit', missionId, expectedRevision: 2, action: 'admit',
    })).toMatchObject({ ok: true, data: { deduplicated: true } });
    expect(calls).toBe(1);
  });
  it('routes the stock CLI action through the identical process-local host', async () => {
    const missionId = await prepare();
    installNativeMissionHost({ durableExecutorReady: () => true, executionAdmission: authority });
    const out = await missionCommand.action!({
      args: ['action'],
      flags: { _: [], requestId: 'cli-admit', mission: missionId,
        expectedRevision: 2, action: 'admit', projectRoot: root },
      cwd: root, interactive: false,
    });
    expect(out).toMatchObject({ success: true, exitCode: 0, data: {
      ok: true, data: { state: 'queued', revision: 3 },
    } });
    expect(await action(missionId, 'cli-admit', 2)).toMatchObject({ ok: true, data: { deduplicated: true } });
  });
  it('awaits asynchronous policy evidence inside the revision fence and deduplicates replay', async () => {
    const missionId = await prepare();
    let checked = 0;
    installNativeMissionHost({
      durableExecutorReady: () => true,
      executionAdmission: async (view, kind) => {
        checked++;
        await Promise.resolve();
        return authority(view, kind);
      },
    });
    const input = { requestId: 'async-admit', missionId, expectedRevision: 2, action: 'admit' };
    const service = nativeMissionService(root, 'cli');
    expect(await service.requestAction(input)).toMatchObject({ ok: true, data: { revision: 3, state: 'queued' } });
    expect(await service.requestAction(input)).toMatchObject({ ok: true, data: { deduplicated: true } });
    expect(checked).toBe(1);
  });
  it('denied asynchronous admission preserves revision and no authorization event', async () => {
    const missionId = await prepare();
    installNativeMissionHost({
      durableExecutorReady: () => true,
      executionAdmission: async (view, kind) => {
        await Promise.resolve();
        return { ...authority(view, kind), policy: { allowed: false, decisionRef: 'policy:denied' } };
      },
    });
    expect(await action(missionId, 'async-deny')).toMatchObject({ ok: false, code: 'admission-denied' });
    expect(await nativeMissionService(root, 'cli').get({ missionId })).toMatchObject({
      ok: true, data: { record: { revision: 2, state: 'planned' }, budget: { reservedMinor: 0 } },
    });
    const events = await nativeMissionService(root, 'cli').events({ missionId });
    expect(events.ok && events.data.events.filter(e => e.type === 'admission.accepted')).toHaveLength(0);
  });
  it('concurrent async admission requests can commit at most one authorization', async () => {
    const missionId = await prepare();
    let evaluated = 0;
    installNativeMissionHost({
      durableExecutorReady: () => true,
      executionAdmission: async (view, kind) => {
        evaluated++;
        await Promise.resolve();
        return authority(view, kind);
      },
    });
    const [first, second] = await Promise.all([
      action(missionId, 'concurrent-a'), action(missionId, 'concurrent-b'),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find(result => !result.ok)).toMatchObject({ code: 'revision-conflict' });
    expect(evaluated).toBe(1);
  });
  it('rejects authority that resolves after Native host revocation', async () => {
    const missionId = await prepare();
    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    installNativeMissionHost({
      durableExecutorReady: () => true,
      executionAdmission: async (view, kind) => {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
        return authority(view, kind);
      },
    });
    const pending = action(missionId, 'revoked-mid-check');
    await checking;
    installNativeMissionHost(null);
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'executor-unavailable' });
    expect(await nativeMissionService(root, 'cli').get({ missionId })).toMatchObject({
      ok: true, data: { record: { revision: 2, state: 'planned' } },
    });
  });
  it('revoking a host invalidates an already created service before admission', async () => {
    const missionId = await prepare();
    installNativeMissionHost({ durableExecutorReady: () => true, executionAdmission: authority });
    const service = nativeMissionService(root, 'cli');
    installNativeMissionHost(null);
    expect(await service.requestAction({ requestId: 'after-revoke', missionId,
      expectedRevision: 2, action: 'admit' })).toMatchObject({ ok: false, code: 'executor-unavailable' });
    const snapshot = await service.get({ missionId });
    expect(snapshot).toMatchObject({ ok: true, data: { record: { revision: 2, state: 'planned' } } });
  });
  it('fails closed for an unready or revoked executor host without changing Mission', async () => {
    const missionId = await prepare();
    let ready = false;
    installNativeMissionHost({ durableExecutorReady: () => ready, executionAdmission: authority });
    expect(await action(missionId)).toMatchObject({ ok: false, code: 'executor-unavailable' });
    ready = true;
    expect(await action(missionId, 'admit2')).toMatchObject({ ok: true, data: { state: 'queued' } });
  });
});
