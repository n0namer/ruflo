/**
 * Durable single-owner execution leases for missions.
 *
 * A lease is an ownership fence, not an authorization or mission transition.
 * Every read/compare/write is performed inside MissionStore.withMission(), whose
 * per-mission lock serializes competing processes. The lease record is replaced
 * atomically and survives process crashes; expiry is evaluated from the injected
 * clock, so a later owner can reclaim a crashed lease with a higher generation.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissionStore, writeFileAtomic } from './store.js';

const LEASE_FILE = 'execution-lease.json';
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ExecutionLease {
  readonly missionId: string;
  readonly ownerId: string;
  /** Decimal fencing generation. It changes only when ownership changes. */
  readonly generation: string;
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

interface StoredLease extends ExecutionLease {
  readonly expiresAtMs: number;
}

export type ExecutionLeaseErrorCode =
  | 'invalid-input'
  | 'mission-not-found'
  | 'lease-held'
  | 'lease-expired'
  | 'stale-generation'
  | 'corrupt-lease';

export class ExecutionLeaseError extends Error {
  constructor(readonly code: ExecutionLeaseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ExecutionLeaseError';
  }
}

export interface ExecutionLeaseOptions {
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
}

function requireOwner(ownerId: unknown): string {
  if (typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) {
    throw new ExecutionLeaseError('invalid-input', 'ownerId must be a bounded identifier');
  }
  return ownerId;
}

function requireTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new ExecutionLeaseError('invalid-input', 'ttlMs must be a positive safe integer');
  }
  return ttlMs;
}

function requireMissionId(missionId: unknown): string {
  if (typeof missionId !== 'string' || !missionId) {
    throw new ExecutionLeaseError('invalid-input', 'missionId must be non-empty');
  }
  return missionId;
}

function parseGeneration(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ExecutionLeaseError('corrupt-lease', 'generation is not a canonical unsigned integer');
  }
  return BigInt(value);
}

function copy(lease: ExecutionLease): ExecutionLease {
  return { ...lease };
}

function storedToPublic(lease: StoredLease): ExecutionLease {
  return copy(lease);
}

/**
 * Mission-scoped durable lease authority. It coordinates ownership only:
 * callers still need the normal mission/policy authorization before executing.
 */
export class ExecutionLeaseStore {
  readonly missionStore: MissionStore;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;

  constructor(projectRoot: string, options: ExecutionLeaseOptions = {}) {
    this.missionStore = new MissionStore(projectRoot);
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = requireTtl(options.defaultTtlMs ?? 30_000);
  }

  private path(missionId: string): string {
    return join(this.missionStore.missionDir(requireMissionId(missionId)), LEASE_FILE);
  }

  private read(missionId: string): StoredLease | null {
    const path = this.path(missionId);
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ExecutionLeaseError('corrupt-lease', error instanceof Error ? error.message : String(error));
    }
    if (!raw || typeof raw !== 'object') {
      throw new ExecutionLeaseError('corrupt-lease', 'lease record must be an object');
    }
    const candidate = raw as Partial<StoredLease>;
    if (
      candidate.missionId !== missionId
      || typeof candidate.ownerId !== 'string'
      || typeof candidate.leaseId !== 'string'
      || typeof candidate.acquiredAt !== 'string'
      || typeof candidate.expiresAt !== 'string'
      || typeof candidate.expiresAtMs !== 'number'
    ) {
      throw new ExecutionLeaseError('corrupt-lease', 'lease record is incomplete');
    }
    requireOwner(candidate.ownerId);
    const generation = parseGeneration(candidate.generation);
    if (generation < 1n || !Number.isSafeInteger(candidate.expiresAtMs) || candidate.expiresAtMs < 0) {
      throw new ExecutionLeaseError('corrupt-lease', 'lease record has invalid generation or expiry');
    }
    return {
      missionId,
      ownerId: candidate.ownerId,
      generation: generation.toString(),
      leaseId: candidate.leaseId,
      acquiredAt: candidate.acquiredAt,
      expiresAt: candidate.expiresAt,
      expiresAtMs: candidate.expiresAtMs,
    };
  }

  private write(missionId: string, lease: StoredLease): void {
    writeFileAtomic(this.path(missionId), JSON.stringify(lease));
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ExecutionLeaseError('invalid-input', 'clock must return a non-negative safe integer timestamp');
    }
    return now;
  }

  async claim(missionId: string, ownerId: string, ttlMs = this.defaultTtlMs): Promise<ExecutionLease> {
    const id = requireMissionId(missionId);
    const owner = requireOwner(ownerId);
    const ttl = requireTtl(ttlMs);
    if (!this.missionStore.exists(id)) throw new ExecutionLeaseError('mission-not-found', id);
    return this.missionStore.withMission(id, (view, log) => {
      void log;
      const current = this.read(id);
      const now = this.timestamp();
      if (current && current.expiresAtMs > now) {
        throw new ExecutionLeaseError('lease-held', `mission is leased by ${current.ownerId}`);
      }
      const generation = (current ? parseGeneration(current.generation) : 0n) + 1n;
      const expiresAtMs = now + ttl;
      if (!Number.isSafeInteger(expiresAtMs)) {
        throw new ExecutionLeaseError('invalid-input', 'lease expiry exceeds safe timestamp range');
      }
      const lease: StoredLease = {
        missionId: id,
        ownerId: owner,
        generation: generation.toString(),
        leaseId: `exec-lease-${randomUUID()}`,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      this.write(id, lease);
      return { events: [], view, result: storedToPublic(lease) };
    });
  }

  async renew(presented: ExecutionLease, ttlMs = this.defaultTtlMs): Promise<ExecutionLease> {
    const ttl = requireTtl(ttlMs);
    const id = requireMissionId(presented?.missionId);
    requireOwner(presented?.ownerId);
    return this.missionStore.withMission(id, (view, log) => {
      void log;
      if (!view && !this.missionStore.exists(id)) throw new ExecutionLeaseError('mission-not-found', id);
      const current = this.read(id);
      const now = this.timestamp();
      this.assertCurrentLease(current, presented, now);
      const expiresAtMs = now + ttl;
      if (!Number.isSafeInteger(expiresAtMs)) throw new ExecutionLeaseError('invalid-input', 'lease expiry exceeds safe timestamp range');
      const renewed: StoredLease = {
        ...current!,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      this.write(id, renewed);
      return { events: [], view, result: storedToPublic(renewed) };
    });
  }

  async release(presented: ExecutionLease): Promise<void> {
    const id = requireMissionId(presented?.missionId);
    return this.missionStore.withMission(id, (view, log) => {
      void log;
      if (!view && !this.missionStore.exists(id)) throw new ExecutionLeaseError('mission-not-found', id);
      const current = this.read(id);
      const now = this.timestamp();
      this.assertCurrentLease(current, presented, now);
      // Keep an expired tombstone so the next owner advances the durable fence.
      this.write(id, { ...current!, expiresAt: new Date(now).toISOString(), expiresAtMs: now });
      return { events: [], view, result: undefined };
    });
  }

  /** Validate a presented fence immediately before protected work. */
  async assertCurrent(presented: ExecutionLease): Promise<void> {
    const id = requireMissionId(presented?.missionId);
    requireOwner(presented?.ownerId);
    return this.missionStore.withMission(id, (view, log) => {
      void log;
      if (!view && !this.missionStore.exists(id)) throw new ExecutionLeaseError('mission-not-found', id);
      this.assertCurrentLease(this.read(id), presented, this.timestamp());
      return { events: [], view, result: undefined };
    });
  }

  async current(missionId: string): Promise<ExecutionLease | null> {
    const id = requireMissionId(missionId);
    if (!this.missionStore.exists(id)) throw new ExecutionLeaseError('mission-not-found', id);
    return this.missionStore.withMission(id, (view, log) => {
      void view; void log;
      const current = this.read(id);
      return { events: [], view, result: current && current.expiresAtMs > this.timestamp() ? storedToPublic(current) : null };
    });
  }

  private assertCurrentLease(current: StoredLease | null, presented: ExecutionLease, now: number): void {
    if (!current) throw new ExecutionLeaseError('stale-generation', 'lease is no longer current');
    if (current.ownerId !== presented.ownerId || current.generation !== presented.generation || current.leaseId !== presented.leaseId) {
      throw new ExecutionLeaseError('stale-generation', 'lease generation or owner is stale');
    }
    if (current.expiresAtMs <= now) throw new ExecutionLeaseError('lease-expired', `lease ${current.leaseId} expired`);
  }
}

/** Compatibility aliases for callers describing the same mission lease authority. */
export const MissionExecutionLease = ExecutionLeaseStore;
export const ExecutionLeaseManager = ExecutionLeaseStore;
