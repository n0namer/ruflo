import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissionService } from '../../src/missions/service.js';
import {
  ExecutionLeaseError,
  ExecutionLeaseStore,
} from '../../src/missions/execution-lease.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-execution-lease-'));
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  const clock = () => now;
  const service = new MissionService({ projectRoot: root, channel: 'cli', now: () => new Date(clock()) });
  return { root, clock, service, advance(ms: number) { now += ms; } };
}

async function mission(service: MissionService): Promise<string> {
  const result = await service.create({ requestId: 'create', objective: 'execute safely' });
  if (!result.ok) throw new Error(result.message);
  return result.data.missionId;
}

describe('durable execution mission lease', () => {
  it('atomically admits one owner and fences the loser', async () => {
    const ctx = setup();
    const id = await mission(ctx.service);
    const left = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 100 });
    const right = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 100 });
    const results = await Promise.allSettled([
      left.claim(id, 'executor-a'),
      right.claim(id, 'executor-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ExecutionLeaseError);
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('lease-held');
    const current = await left.current(id);
    expect(current?.ownerId).toMatch(/^executor-/);
    expect(current?.generation).toBe('1');
    await expect(left.assertCurrent(current!)).resolves.toBeUndefined();
    await expect(left.assertCurrent({ ...current!, ownerId: 'executor-attacker' })).rejects.toMatchObject({ code: 'stale-generation' });
  });

  it('reclaims an expired owner with a higher durable generation', async () => {
    const ctx = setup();
    const id = await mission(ctx.service);
    const first = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 50 });
    const second = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 50 });
    const old = await first.claim(id, 'executor-old');
    ctx.advance(51);
    const replacement = await second.claim(id, 'executor-new');
    expect(replacement.generation).toBe('2');
    expect(replacement.ownerId).toBe('executor-new');
    await expect(first.renew(old)).rejects.toMatchObject({ code: 'stale-generation' });
    await expect(first.release(old)).rejects.toMatchObject({ code: 'stale-generation' });
  });

  it('survives a manager restart and refuses stale or expired operations', async () => {
    const ctx = setup();
    const id = await mission(ctx.service);
    const first = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 100 });
    const old = await first.claim(id, 'executor-a');
    const restarted = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 100 });
    expect(await restarted.current(id)).toMatchObject({ leaseId: old.leaseId, generation: '1' });
    await expect(restarted.renew({ ...old, generation: '0' })).rejects.toMatchObject({ code: 'stale-generation' });
    ctx.advance(101);
    await expect(restarted.renew(old)).rejects.toMatchObject({ code: 'lease-expired' });
    const next = await restarted.claim(id, 'executor-b');
    expect(next.generation).toBe('2');
    const persisted = JSON.parse(readFileSync(join(ctx.root, '.claude-flow', 'missions', id, 'execution-lease.json'), 'utf8'));
    expect(persisted.generation).toBe('2');
  });

  it('preserves fencing generation across explicit release and reacquire', async () => {
    const ctx = setup();
    const leases = new ExecutionLeaseStore(ctx.root, { now: ctx.clock, defaultTtlMs: 100 });
    const id = await mission(ctx.service);
    const first = await leases.claim(id, 'executor-a');
    await leases.release(first);
    const second = await leases.claim(id, 'executor-b');
    expect(second.generation).toBe('2');
    await expect(leases.assertCurrent(first)).rejects.toMatchObject({ code: 'stale-generation' });
    await expect(leases.renew(first)).rejects.toMatchObject({ code: 'stale-generation' });
    await expect(leases.release(first)).rejects.toMatchObject({ code: 'stale-generation' });
    await expect(leases.assertCurrent(second)).resolves.toBeUndefined();
  });

  it('rejects invalid input, missing missions, and release after expiry', async () => {
    const ctx = setup();
    const leases = new ExecutionLeaseStore(ctx.root, { now: ctx.clock });
    const missing = `msn_${'0'.repeat(24)}`;
    await expect(leases.claim(missing, 'executor-a')).rejects.toMatchObject({ code: 'mission-not-found' });
    const id = await mission(ctx.service);
    await expect(leases.claim(id, '', 1)).rejects.toMatchObject({ code: 'invalid-input' });
    const held = await leases.claim(id, 'executor-a', 10);
    ctx.advance(11);
    await expect(leases.release(held)).rejects.toMatchObject({ code: 'lease-expired' });
  });
});
