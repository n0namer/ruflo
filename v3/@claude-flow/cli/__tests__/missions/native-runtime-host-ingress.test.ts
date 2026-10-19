import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionService } from '../../src/missions/service.js';
import { installNativeMissionHost, nativeMissionRuntimeService } from '../../src/missions/native-runtime-host.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-internal-ingress-')); });
afterEach(() => { installNativeMissionHost(null); rmSync(root, { recursive: true, force: true }); });

async function planned() {
  const s = new MissionService({ projectRoot: root, channel: 'cli' });
  const created = await s.create({ requestId: 'new', objective: 'Authorized runtime event ingress' });
  if (!created.ok) throw new Error(created.message);
  const id = created.data.missionId;
  const next = await s.plan({ requestId: 'plan', expectedRevision: 1, missionId: id, plan: plan() });
  if (!next.ok) throw new Error(next.message);
  return id;
}
describe('registered Native host internal event transport', () => {
  it('remains fail closed without registered authority', async () => {
    const missionId = await planned();
    expect(await nativeMissionRuntimeService(root).recordNativeEvent({
      requestId: 'not-authorized', missionId, expectedRevision: 2,
      type: 'executor.acknowledged', payload: { executorId: 'executor', leaseEpoch: 0 },
    })).toMatchObject({ ok: false, code: 'executor-unavailable' });
  });
  it('refuses events after revocation even from a service constructed earlier', async () => {
    const missionId = await planned();
    installNativeMissionHost({
      durableExecutorReady: () => true,
      executionAdmission: () => null,
      authorizeRuntimeEvent: async () => ({ authorized: true, receiptRef: 'native:QA-receipt', independentQa: true }),
    });
    const runtime = nativeMissionRuntimeService(root);
    installNativeMissionHost(null);
    expect(await runtime.recordNativeEvent({
      requestId: 'revoked', missionId, expectedRevision: 2,
      type: 'executor.acknowledged', payload: { executorId: 'executor', leaseEpoch: 0 },
    })).toMatchObject({ ok: false, code: 'admission-denied' });
    expect(await new MissionService({ projectRoot: root, channel: 'cli' }).get({ missionId }))
      .toMatchObject({ ok: true, data: { record: { revision: 2, state: 'planned' } } });
  });
});
