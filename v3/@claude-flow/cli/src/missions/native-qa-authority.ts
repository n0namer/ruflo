/**
 * ADR-406 M2 - independent reviewer evidence adapter.
 *
 * The stock MissionStore and ExecutionInvocationJournal remain authoritative.
 * This adapter NEVER launches review, mints reviewer credentials, settles the
 * journal or records Native terminal. All reviewer receipts are retrieved from
 * a separate trusted authority and independently authenticated by the host.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionInvocationJournal } from './execution-invocation-journal.js';
import { verifyStockMissionOutcome } from './execution-quality.js';
import type { IndependentQaReceipt, StockMissionOutcome } from './execution-quality.js';
import type { MissionView } from './transitions.js';
import type { CodexDispatchReceipt } from './execution-dispatch-binding.js';
import type { VerifiedTaskResult } from './native-ready-cycle.js';

const SHA = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TrustedReviewerReadback {
  readonly receipt: IndependentQaReceipt;
  /** Derived from the authenticated REVIEWER SERVICE, never the receipt body. */
  readonly principalId: string;
  readonly authenticatedReceiptId: string;
}

export interface IndependentQaAuthorityPorts {
  readonly projectRoot: string;
  /** Original, host-authenticated Codex outcome; never worker stdout. */
  readonly readStockOutcome: (missionId: string, invocationId: string) =>
    Promise<StockMissionOutcome | null>;
  /** Retrieves reviewer evidence by invocation from an independent authority. */
  readonly readReviewer: (missionId: string, invocationId: string) =>
    Promise<TrustedReviewerReadback | null>;
  /** Authentication must verify authority signature/identity, not a boolean in JSON. */
  readonly authenticateReviewer: (
    evidence: TrustedReviewerReadback, missionId: string, invocationId: string,
  ) => Promise<boolean>;
  /** Independent file reader recomputes SHA-256 from the actual artifact bytes. */
  readonly readArtifactDigest: (taskId: string) => Promise<string | null>;
  /** Source state, obtained from the same canonical Git workspace as admission. */
  readonly readSourceDigest: () => Promise<string | null>;
  readonly workerPrincipalId: string;
}

export function createNativeAuthorizedQaReview(ports: IndependentQaAuthorityPorts) {
  if (!ports || typeof ports.projectRoot !== 'string' ||
      !ID.test(ports.workerPrincipalId) ||
      ['readStockOutcome','readReviewer','authenticateReviewer',
       'readArtifactDigest','readSourceDigest'].some(
        key => typeof ports[key as keyof IndependentQaAuthorityPorts] !== 'function')) {
    throw new TypeError('independent QA requires authenticated stock + reviewer ports');
  }
  const root = realpathSync(resolve(ports.projectRoot));
  const journal = new ExecutionInvocationJournal(root);
  return async (taskId: string, dispatch: CodexDispatchReceipt, view: MissionView):
    Promise<VerifiedTaskResult | null> => {
    if (!view?.planBody || view.record.state !== 'running' ||
        !view.planBody.tasks.some(t => t.id === taskId) ||
        dispatch?.taskId !== taskId || dispatch?.missionId !== view.record.missionId ||
        dispatch.status !== 'completed' || dispatch.outcome !== 'completed' ||
        dispatch.exitCode !== 0 || !dispatch.physicalThreadId ||
        !Number.isSafeInteger(dispatch.pid) || dispatch.pid! <= 0) return null;
    try {
      // The once-dispatch port must have journaled this physical invocation
      // BEFORE running Codex. Unknown/succeeded/failed are NOT fresh QA claims.
      const original = await journal.get(dispatch.missionId, dispatch.invocationId);
      if (!original || original.status !== 'dispatched' ||
          original.taskId !== taskId ||
          original.planRevision !== view.record.plan.revision ||
          original.leaseGeneration !== String(view.lease.epoch) ||
          original.authority.decisionRef !== view.record.authorizationRef ||
          original.ownerId !== ports.workerPrincipalId) return null;
      const source = await ports.readSourceDigest();
      if (!source || !SHA.test(source) || source !== original.sourceDigest) return null;
      const [outcome, reviewer, digest] = await Promise.all([
        ports.readStockOutcome(dispatch.missionId, dispatch.invocationId),
        ports.readReviewer(dispatch.missionId, dispatch.invocationId),
        ports.readArtifactDigest(taskId),
      ]);
      if (!outcome || !reviewer || !digest || !SHA.test(digest)) return null;
      if (!ID.test(reviewer.principalId) || !ID.test(reviewer.authenticatedReceiptId) ||
          reviewer.principalId === ports.workerPrincipalId ||
          reviewer.principalId === dispatch.threadId ||
          reviewer.principalId === dispatch.physicalThreadId ||
          reviewer.receipt?.receiptId !== reviewer.authenticatedReceiptId ||
          reviewer.receipt.producer.qaRunId === dispatch.invocationId) return null;
      if (outcome.missionId !== dispatch.missionId ||
          outcome.executionId !== dispatch.invocationId ||
          outcome.planRevision !== view.record.plan.revision ||
          outcome.criteriaDigest !== view.record.acceptance.criteriaDigest ||
          outcome.artifactDigest !== digest) return null;
      const verification = verifyStockMissionOutcome(outcome, reviewer.receipt);
      if (!verification.accepted) return null;
      // This check is not optional: structural QA receipts are forgeable.
      if (await ports.authenticateReviewer(reviewer, dispatch.missionId, dispatch.invocationId) !== true)
        return null;
      return Object.freeze({
        accepted: true as const,
        artifactDigest: digest,
        reviewerRunId: reviewer.receipt.producer.qaRunId,
        evidenceId: reviewer.receipt.receiptId,
      });
    } catch {
      return null;
    }
  };
}
