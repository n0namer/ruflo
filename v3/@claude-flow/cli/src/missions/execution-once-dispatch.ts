/**
 * ADR-406 M2: once-only boundary between the stock durable invocation journal
 * and the existing CodexDispatchBinding. No DAG, worker runner or second ledger.
 *
 * The journal's per-mission lock reserves an invocation BEFORE any process
 * effect. A different dispatchRef on a replay means a prior attempt may be
 * running; never start a second process based on a missing/ambiguous response.
 *
 * A completed dispatch is only a physical observation. Independent acceptance,
 * terminal Mission events and budget settlement remain separate authorities.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ExecutionInvocationJournal,
  InvocationIntent,
  InvocationReceipt,
} from './execution-invocation-journal.js';
import type {
  CodexDispatchBinding,
  CodexDispatchReceipt,
  CodexDispatchRequest,
} from './execution-dispatch-binding.js';

export interface OnceDispatchOptions {
  readonly intent: InvocationIntent;
  readonly request: CodexDispatchRequest;
  readonly journal: Pick<ExecutionInvocationJournal, 'prepare' | 'markDispatched'>;
  readonly binding: Pick<CodexDispatchBinding, 'dispatch'>;
}

export type OnceDispatchResult =
  | { readonly kind: 'observed'; readonly dispatchRef: string; readonly receipt: CodexDispatchReceipt }
  | { readonly kind: 'blocked'; readonly reason: 'binding-mismatch' | 'previously-dispatched' | 'journal-refused' }
  | { readonly kind: 'unresolved'; readonly reason: 'journal-unknown' | 'dispatch-unknown'; readonly dispatchRef?: string };

function bound(intent: InvocationIntent, request: CodexDispatchRequest): boolean {
  if (!intent || !request || typeof request.prompt !== 'string' || !request.prompt.trim()) return false;
  const invocation = request.invocation;
  const credential = request.credential;
  const lease = request.lease;
  if (!invocation || !credential || !lease) return false;
  const inputDigest = 'sha256:' + createHash('sha256').update(request.prompt, 'utf8').digest('hex');
  return intent.inputDigest === inputDigest
    && intent.missionId === invocation.missionId
    && intent.missionId === credential.missionId
    && intent.missionId === lease.missionId
    && intent.taskId === invocation.taskId
    && intent.taskId === credential.taskId
    && intent.invocationId === invocation.invocationId
    && intent.invocationId === credential.invocationId
    && intent.ownerId === credential.ownerId
    && intent.ownerId === lease.ownerId
    && intent.sessionId === credential.sessionId
    && intent.leaseGeneration === lease.generation
    && Number.isSafeInteger(invocation.missionEpoch)
    && String(invocation.missionEpoch) === intent.leaseGeneration
    && invocation.threadId === credential.threadId
    && invocation.planDigest === credential.planDigest;
}

/** Safe across parallel callers sharing the same durable MissionStore. */
export async function dispatchOnce(options: OnceDispatchOptions): Promise<OnceDispatchResult> {
  const { intent, request, journal, binding } = options;
  if (!bound(intent, request)) return { kind: 'blocked', reason: 'binding-mismatch' };

  let prepared: InvocationReceipt;
  try {
    prepared = await journal.prepare(intent);
  } catch {
    return { kind: 'blocked', reason: 'journal-refused' };
  }
  if (prepared.status !== 'prepared') return { kind: 'blocked', reason: 'previously-dispatched' };

  // A different concurrent caller uses an independent random ref; the journal
  // serializes markDispatched and returns the winner's original dispatchRef.
  const dispatchRef = 'dispatch-' + randomUUID();
  let marked: InvocationReceipt;
  try {
    marked = await journal.markDispatched(intent, dispatchRef);
  } catch {
    // The atomic write could have committed before an uncertain response.
    return { kind: 'unresolved', reason: 'journal-unknown' };
  }
  if (marked.status !== 'dispatched' || marked.dispatchRef !== dispatchRef) {
    return { kind: 'blocked', reason: 'previously-dispatched' };
  }

  try {
    const receipt = await binding.dispatch(request);
    return { kind: 'observed', dispatchRef, receipt };
  } catch {
    // Do not reuse the invocationId even if no process receipt was returned.
    return { kind: 'unresolved', reason: 'dispatch-unknown', dispatchRef };
  }
}
