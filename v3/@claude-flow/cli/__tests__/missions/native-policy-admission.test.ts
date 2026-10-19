import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { createNativePolicyHost } from '../../src/missions/native-policy-admission.js';
import { nativeMissionService, installNativeMissionHost } from '../../src/missions/native-runtime-host.js';
import { loadPolicyState, setPolicyMode, upsertPolicyRule } from '../../src/services/policy-runtime.js';
import { plan } from './helpers.js';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ruflo-policy-m2-'));
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.claude-flow/\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Ruflo Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
});
afterEach(() => {
  installNativeMissionHost(null);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

async function planned(): Promise<string> {
  const s = new MissionService({ projectRoot: root, channel: 'cli' });
  const result = await s.create({ requestId: 'init', objective: 'ADR406 isolated policy admission fixture' });
  if (!result.ok) throw Error(result.message);
  const next = await s.plan({ requestId: 'plan', missionId: result.data.missionId,
    expectedRevision: 1, plan: plan() });
  if (!next.ok) throw Error(next.message);
  return result.data.missionId;
}
async function admit(missionId: string, action: 'admit' | 'resume' = 'admit') {
  return nativeMissionService(root, 'cli').requestAction({
    requestId: 'policy-admit-' + action, missionId, expectedRevision: 2, action,
  });
}

describe('stock policy runtime to native mission admission', () => {
  it('does not convert absent/legacy policy into permission', async () => {
    const id = await planned();
    installNativeMissionHost(createNativePolicyHost(root, { durableExecutorReady: () => true }));
    expect(await admit(id)).toMatchObject({ ok: false, code: 'executor-unavailable' });
  });
  it('enforces actual policy receipts and commits mission budget atomically', async () => {
    const id = await planned();
    await setPolicyMode('enforce', root);
    await upsertPolicyRule({ id: 'native-explicit-allow', effect: 'allow',
      actions: ['mission.execute', 'mission.capability.fs.write'] }, root);
    installNativeMissionHost(createNativePolicyHost(root, { durableExecutorReady: () => true }));
    const result = await admit(id);
    expect(result).toMatchObject({ ok: true, data: { state: 'queued', revision: 3 } });
    const state = loadPolicyState(root);
    expect(state.mode).toBe('enforce');
    expect(state.receipts.length).toBeGreaterThanOrEqual(2);
    const readback = await nativeMissionService(root, 'cli').get({ missionId: id });
    expect(readback).toMatchObject({ ok: true, data: {
      record: { state: 'queued', authorizationRef: expect.stringMatching(/^policy-grants:sha256:/) },
      budget: { reservedMinor: 150 },
    } });
  });
  it('explicit execution allow is insufficient without each capability rule', async () => {
    const id = await planned();
    await setPolicyMode('enforce', root);
    await upsertPolicyRule({ id: 'only-execute', effect: 'allow', actions: ['mission.execute'] }, root);
    installNativeMissionHost(createNativePolicyHost(root, { durableExecutorReady: () => true }));
    expect(await admit(id)).toMatchObject({ ok: false, code: 'executor-unavailable' });
    expect(await nativeMissionService(root, 'cli').get({ missionId: id })).toMatchObject({
      ok: true, data: { record: { state: 'planned', revision: 2 }, budget: { reservedMinor: 0 } },
    });
  });
  it('refuses a different workspace or principal even if host policy permits execution', async () => {
    const id = await planned();
    await setPolicyMode('enforce', root);
    await upsertPolicyRule({ id: 'native-allow', effect: 'allow',
      actions: ['mission.execute', 'mission.capability.fs.write'] }, root);
    const host = createNativePolicyHost(root, { durableExecutorReady: () => true });
    const view = new MissionStore(root).loadView(id)!;
    expect(await host.executionAdmission({
      ...view, record: { ...view.record, workspaceId: 'ws_wrong_workspace' },
    }, 'admit')).toBeNull();
    expect(await host.executionAdmission({
      ...view, record: { ...view.record, ownerPrincipalId: 'local:other-user' },
    }, 'admit')).toBeNull();
  });
  it('dirty source and unready executor deny without issuing execution authority', async () => {
    const id = await planned();
    await setPolicyMode('enforce', root);
    await upsertPolicyRule({ id: 'allow', effect: 'allow',
      actions: ['mission.execute', 'mission.capability.fs.write'] }, root);
    let ready = false;
    installNativeMissionHost(createNativePolicyHost(root, { durableExecutorReady: () => ready }));
    expect(await admit(id)).toMatchObject({ ok: false, code: 'executor-unavailable' });
    ready = true;
    writeFileSync(join(root, 'dirty.txt'), 'not approved in source tree');
    expect(await admit(id)).toMatchObject({ ok: false, code: 'executor-unavailable' });
  });
});
