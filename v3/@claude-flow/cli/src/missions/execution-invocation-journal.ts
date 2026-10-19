import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissionStore, writeFileAtomic } from './store.js';

const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface InvocationAuthority {
  readonly decisionRef: string;
  readonly policyDigest: string;
}

export interface InvocationIntent {
  readonly missionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly planRevision: number;
  readonly leaseGeneration: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly policyRef: string;
  readonly policyDigest: string;
  readonly sourceDigest: string;
  readonly inputDigest: string;
  readonly authority: InvocationAuthority;
}

export type InvocationStatus = 'prepared' | 'dispatched' | 'succeeded' | 'failed';

export interface InvocationReceipt extends InvocationIntent {
  readonly status: InvocationStatus;
  readonly preparedAt: string;
  readonly dispatchedAt?: string;
  readonly completedAt?: string;
  readonly dispatchRef?: string;
  readonly outcomeDigest?: string;
  readonly receiptRef?: string;
}

export class InvocationJournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'InvocationJournalError';
  }
}

function requireIntent(raw: InvocationIntent): InvocationIntent {
  if (!raw || typeof raw !== 'object') throw new InvocationJournalError('invalid-input', 'invocation intent is required');
  const intent = raw as InvocationIntent;
  if (
    typeof intent.missionId !== 'string' || !intent.missionId
    || typeof intent.taskId !== 'string' || !intent.taskId
    || typeof intent.invocationId !== 'string' || !INVOCATION_ID.test(intent.invocationId)
    || !Number.isSafeInteger(intent.planRevision) || intent.planRevision < 0
    || typeof intent.leaseGeneration !== 'string' || !/^[1-9][0-9]*$/.test(intent.leaseGeneration)
    || typeof intent.ownerId !== 'string' || !intent.ownerId
    || typeof intent.sessionId !== 'string' || !intent.sessionId
    || typeof intent.policyRef !== 'string' || !intent.policyRef
    || !DIGEST.test(intent.policyDigest) || !DIGEST.test(intent.sourceDigest) || !DIGEST.test(intent.inputDigest)
    || !intent.authority || typeof intent.authority.decisionRef !== 'string' || !intent.authority.decisionRef
    || intent.authority.policyDigest !== intent.policyDigest
  ) {
    throw new InvocationJournalError('invalid-input', 'intent is incomplete or contains invalid digests');
  }
  return intent;
}

function sameIntent(a: InvocationReceipt, b: InvocationIntent): boolean {
  return JSON.stringify({
    missionId: a.missionId, taskId: a.taskId, invocationId: a.invocationId,
    planRevision: a.planRevision, leaseGeneration: a.leaseGeneration, ownerId: a.ownerId,
    sessionId: a.sessionId, policyRef: a.policyRef, policyDigest: a.policyDigest,
    sourceDigest: a.sourceDigest, inputDigest: a.inputDigest,
    authority: { decisionRef: a.authority.decisionRef, policyDigest: a.authority.policyDigest },
  }) === JSON.stringify({
    missionId: b.missionId, taskId: b.taskId, invocationId: b.invocationId,
    planRevision: b.planRevision, leaseGeneration: b.leaseGeneration, ownerId: b.ownerId,
    sessionId: b.sessionId, policyRef: b.policyRef, policyDigest: b.policyDigest,
    sourceDigest: b.sourceDigest, inputDigest: b.inputDigest,
    authority: { decisionRef: b.authority.decisionRef, policyDigest: b.authority.policyDigest },
  });
}

function validateReceiptShape(raw: unknown): InvocationReceipt {
  if (!raw || typeof raw !== 'object') {
    throw new InvocationJournalError('corrupt-receipt', 'receipt must be an object');
  }
  const receipt = raw as InvocationReceipt;
  if (!['prepared', 'dispatched', 'succeeded', 'failed'].includes(receipt.status)) {
    throw new InvocationJournalError('corrupt-receipt', 'unknown invocation status');
  }
  if (typeof receipt.preparedAt !== 'string' || !receipt.preparedAt) {
    throw new InvocationJournalError('corrupt-receipt', 'prepared receipt timestamp is missing');
  }
  if (receipt.status === 'dispatched'
    && (typeof receipt.dispatchRef !== 'string' || !receipt.dispatchRef || typeof receipt.dispatchedAt !== 'string' || !receipt.dispatchedAt)) {
    throw new InvocationJournalError('corrupt-receipt', 'dispatched receipt is incomplete');
  }
  if ((receipt.status === 'succeeded' || receipt.status === 'failed')
    && (typeof receipt.outcomeDigest !== 'string' || !DIGEST.test(receipt.outcomeDigest)
      || typeof receipt.receiptRef !== 'string' || !receipt.receiptRef
      || typeof receipt.completedAt !== 'string' || !receipt.completedAt)) {
    throw new InvocationJournalError('corrupt-receipt', 'completed receipt is incomplete');
  }
  return receipt;
}

function validateReceipt(raw: unknown, intent: InvocationIntent): InvocationReceipt {
  if (!raw || typeof raw !== 'object' || !sameIntent(raw as InvocationReceipt, intent)) {
    throw new InvocationJournalError('invocation-conflict', 'invocation id is already bound to different input');
  }
  return validateReceiptShape(raw);
}

export interface ExecutionInvocationJournalOptions {
  readonly now?: () => number;
}

interface StoredLease {
  readonly missionId: string;
  readonly ownerId: string;
  readonly generation: string;
  readonly expiresAtMs: number;
}

export class ExecutionInvocationJournal {
  readonly missionStore: MissionStore;
  private readonly now: () => number;

  constructor(projectRoot: string, options: ExecutionInvocationJournalOptions = {}) {
    this.missionStore = new MissionStore(projectRoot);
    this.now = options.now ?? Date.now;
  }

  private invocationPath(intent: InvocationIntent): string {
    return join(this.missionStore.missionDir(intent.missionId), 'invocations', `${intent.invocationId}.json`);
  }

  private currentLease(intent: InvocationIntent): StoredLease {
    const path = join(this.missionStore.missionDir(intent.missionId), 'execution-lease.json');
    if (!existsSync(path)) throw new InvocationJournalError('stale-lease', 'no durable lease is active');
    try {
      const lease = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredLease>;
      if (
        lease.missionId !== intent.missionId
        || lease.ownerId !== intent.ownerId
        || lease.generation !== intent.leaseGeneration
        || typeof lease.expiresAtMs !== 'number'
        || !Number.isSafeInteger(lease.expiresAtMs)
        || lease.expiresAtMs <= this.now()
      ) throw new Error('lease is stale or expired');
      return lease as StoredLease;
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError('stale-lease', error instanceof Error ? error.message : String(error));
    }
  }

  private load(intent: InvocationIntent): InvocationReceipt | null {
    const path = this.invocationPath(intent);
    if (!existsSync(path)) return null;
    try {
      return validateReceipt(JSON.parse(readFileSync(path, 'utf8')), intent);
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError('corrupt-receipt', error instanceof Error ? error.message : String(error));
    }
  }

  private async withIntent<T>(intent: InvocationIntent, action: (existing: InvocationReceipt | null) => T): Promise<T> {
    const checked = requireIntent(intent);
    if (!this.missionStore.exists(checked.missionId)) throw new InvocationJournalError('mission-not-found', checked.missionId);
    return this.missionStore.withMission(checked.missionId, (view) => {
      this.currentLease(checked);
      return { events: [], view, result: action(this.load(checked)) };
    });
  }

  async prepare(intent: InvocationIntent): Promise<InvocationReceipt> {
    const checked = requireIntent(intent);
    return this.withIntent(checked, (existing) => {
      if (existing) return existing;
      const prepared: InvocationReceipt = {
        ...checked,
        status: 'prepared',
        preparedAt: new Date(this.now()).toISOString(),
      };
      const path = this.invocationPath(checked);
      this.currentLease(checked);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileAtomic(path, JSON.stringify(prepared));
      return prepared;
    });
  }

  async get(missionId: string, invocationId: string): Promise<InvocationReceipt | null> {
    if (typeof missionId !== 'string' || !missionId || !INVOCATION_ID.test(invocationId)) {
      throw new InvocationJournalError('invalid-input', 'missionId and invocationId are required');
    }
    const path = join(this.missionStore.missionDir(missionId), 'invocations', `${invocationId}.json`);
    if (!existsSync(path)) return null;
    try {
      return validateReceiptShape(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError('corrupt-receipt', error instanceof Error ? error.message : String(error));
    }
  }

  async markDispatched(intent: InvocationIntent, dispatchRef: string): Promise<InvocationReceipt> {
    if (typeof dispatchRef !== 'string' || !dispatchRef) throw new InvocationJournalError('invalid-input', 'dispatchRef is required');
    return this.withIntent(intent, (existing) => {
      if (!existing) throw new InvocationJournalError('missing-receipt', 'prepare must precede dispatch');
      if (existing.status === 'succeeded' || existing.status === 'failed') return existing;
      if (existing.status === 'dispatched') return existing;
      const next: InvocationReceipt = {
        ...existing, status: 'dispatched', dispatchRef, dispatchedAt: new Date(this.now()).toISOString(),
      };
      this.currentLease(requireIntent(intent));
      writeFileAtomic(this.invocationPath(existing), JSON.stringify(next));
      return next;
    });
  }

  async recordOutcome(
    intent: InvocationIntent,
    outcome: 'succeeded' | 'failed',
    outcomeDigest: string,
    receiptRef: string,
  ): Promise<InvocationReceipt> {
    if (!['succeeded', 'failed'].includes(outcome) || !DIGEST.test(outcomeDigest) || typeof receiptRef !== 'string' || !receiptRef) {
      throw new InvocationJournalError('invalid-input', 'verified outcome requires a digest and receipt reference');
    }
    return this.withIntent(intent, (existing) => {
      if (!existing) throw new InvocationJournalError('missing-receipt', 'prepare must precede outcome');
      if (existing.status === 'succeeded' || existing.status === 'failed') return existing;
      if (existing.status !== 'dispatched') throw new InvocationJournalError('invalid-transition', 'dispatch must precede outcome');
      const next: InvocationReceipt = {
        ...existing, status: outcome, outcomeDigest, receiptRef, completedAt: new Date(this.now()).toISOString(),
      };
      this.currentLease(requireIntent(intent));
      writeFileAtomic(this.invocationPath(existing), JSON.stringify(next));
      return next;
    });
  }
}
