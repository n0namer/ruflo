import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionService, type MissionView } from '../../src/missions/index.js';
import type { ExecutionAdmissionRequest } from '../../src/missions/execution-admission.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-m2-admission-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function proof(view: MissionView, action: 'admit' | 'resume'): ExecutionAdmissionRequest {
  const canonical = root.replace(/\\/g, '/');
  const budget = view.budget!;
  return {
    action,
    worktree: {
      rooted: true, root: canonical, candidate: canonical, repositoryId: 'test-repo',
      sourceStateId: 'source-test-snapshot',
    },
    policy: { allowed: true, decisionRef: 'policy:independently-verified' },
    budget: {
      allowed: true, reservationRef: 'budget:held',
      estimatedMinor: budget.estimatedMinor,
      remainingMinor: budget.ceilingMinor - budget.reservedMinor - budget.settledMinor - budget.unresolvedMinor,
    },
    permissions: {
      granted: true, required: ['fs.write'], explicit: ['fs.write'],
      authorizationRef: 'auth:local-test',
    },
    evidenceRefs: ['worktree:receipt', 'policy:receipt', 'budget:receipt', 'permission:receipt'],
  };
}

async function planned(service: MissionService) {
  const create = await service.create({ requestId: 'create', objective: 'Controlled test Mission' });
  if (!create.ok) throw new Error(create.message);
  const missionId = create.data.missionId;
  const result = await service.plan({ requestId: 'plan', missionId, expectedRevision: 1, plan: plan() });
  if (!result.ok) throw new Error(result.message);
  return missionId;
}

describe('MissionService trusted M2 admission bridge', () => {
  it('remains fail closed without a Native admission authority', async () => {
    const svc = new MissionService({ projectRoot: root, channel: 'cli' });
    const id = await planned(svc);
    expect(await svc.requestAction({ requestId: 'admit', missionId: id, expectedRevision: 2, action: 'admit' }))
      .toMatchObject({ ok: false, code: 'executor-unavailable' });
  });

  it('records one native admission event and deduplicates a repeated request without reevaluating authority', async () => {
    let checked = 0;
    const admission = (view: MissionView, action: 'admit' | 'resume') => { checked += 1; return proof(view, action); };
    const svc = new MissionService({ projectRoot: root, channel: 'cli', executionAdmission: admission });
    const id = await planned(svc);
    const command = { requestId: 'admit', missionId: id, expectedRevision: 2, action: 'admit' };
    expect(await svc.requestAction(command)).toMatchObject({ ok: true, data: { state: 'queued', revision: 3, deduplicated: false } });
    expect(await svc.requestAction(command)).toMatchObject({ ok: true, data: { deduplicated: true } });
    expect(checked).toBe(1);
    const readback = await svc.get({ missionId: id });
    expect(readback).toMatchObject({ ok: true, data: { record: { state: 'queued', authorizationRef: 'auth:local-test' }, budget: { reservedMinor: 150 } } });
    const events = await svc.events({ missionId: id });
    expect(events.ok && events.data.events.filter((e) => e.type === 'admission.accepted')).toHaveLength(1);
    expect(events.ok && events.data.events.find((e) => e.type === 'admission.accepted')?.policyDecisionRef)
      .toBe('policy:independently-verified');
  });

  it('rejects denied policy and leaves plan revision unchanged', async () => {
    const svc = new MissionService({
      projectRoot: root, channel: 'mcp',
      executionAdmission: (view, action) => ({ ...proof(view, action), policy: { allowed: false } }),
    });
    const id = await planned(svc);
    expect(await svc.requestAction({ requestId: 'blocked', missionId: id, expectedRevision: 2, action: 'admit' }))
      .toMatchObject({ ok: false, code: 'admission-denied' });
    expect(await svc.get({ missionId: id })).toMatchObject({ ok: true, data: { record: { state: 'planned', revision: 2 } } });
  });

  it('rejects forged or stale budget evidence without durable state mutation', async () => {
    const svc = new MissionService({
      projectRoot: root, channel: 'cli',
      executionAdmission: (view, action) => ({
        ...proof(view, action),
        budget: { ...proof(view, action).budget, estimatedMinor: 0 },
      }),
    });
    const id = await planned(svc);
    expect(await svc.requestAction({ requestId: 'budget', missionId: id, expectedRevision: 2, action: 'admit' }))
      .toMatchObject({ ok: false, code: 'admission-denied' });
    expect(await svc.get({ missionId: id })).toMatchObject({ ok: true, data: { budget: { reservedMinor: 0 } } });
  });

  it('rejects session-bound plans even with an injected authority', async () => {
    const svc = new MissionService({ projectRoot: root, channel: 'cli', executionAdmission: proof });
    const created = await svc.create({ requestId: 'c', objective: 'session-bound attempt' });
    if (!created.ok) throw new Error(created.message);
    const id = created.data.missionId;
    const body = plan();
    const session = { ...body, tasks: body.tasks.map((t) => ({ ...t, executor: { ...t.executor, mode: 'session-bound' as const } })) };
    expect(await svc.plan({ requestId: 'p', missionId: id, expectedRevision: 1, plan: session })).toMatchObject({ ok: true });
    expect(await svc.requestAction({ requestId: 'a', missionId: id, expectedRevision: 2, action: 'admit' }))
      .toMatchObject({ ok: false, code: 'executor-unavailable' });
  });
});
