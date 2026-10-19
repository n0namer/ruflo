/**
 * ADR-406: verify an externally issued Ed25519 reviewer receipt with a
 * separately provisioned and pinned public key. Does not issue credentials,
 * generate key material, mint a QA receipt or bypass stock Mission QA gates.
 */
import { createPublicKey, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import { createNativeAuthorizedQaReview } from './native-qa-authority.js';
import type { TrustedReviewerReadback, IndependentQaAuthorityPorts } from './native-qa-authority.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const canonical = (record: TrustedReviewerReadback) => {
  const { receipt, principalId, authenticatedReceiptId } = record;
  // Fixed order, fixed version, every identity/decision/hash is signed.
  return JSON.stringify([
    'ruflo.m2.qa-attestation/v1', principalId, authenticatedReceiptId,
    receipt.schema, receipt.receiptId, receipt.missionId, receipt.executionId,
    receipt.planRevision, receipt.criteriaDigest, receipt.artifactDigest,
    receipt.verdict, receipt.producer.kind, receipt.producer.qaRunId,
    receipt.evidenceRef, receipt.issuedAt,
  ]);
};

export interface SignedReviewerReadback extends TrustedReviewerReadback {
  /** Signature generated ONLY by the independently authenticated QA process. */
  readonly signatureBase64: string;
}

export interface PinnedQaVerifierOptions {
  /** Pinned, trusted Ed25519 public key, provisioned outside the model worker. */
  readonly publicKeyPem: string;
  readonly reviewerPrincipalId: string;
  /** Reject stale receipts; default 10 minutes, never unbounded. */
  readonly maxReceiptAgeMs?: number;
  readonly now?: () => number;
}

export function createPinnedQaAuthenticator(config: PinnedQaVerifierOptions) {
  if (!config || !ID.test(config.reviewerPrincipalId) ||
      typeof config.publicKeyPem !== 'string' || !config.publicKeyPem.trim()) {
    throw new TypeError('pinned QA verifier requires a public key and a reviewer identity');
  }
  const key: KeyObject = createPublicKey(config.publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('QA public key must be Ed25519');
  const maxAge = config.maxReceiptAgeMs ?? 600_000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1000 || maxAge > 86_400_000)
    throw new RangeError('QA receipt max age must be between 1 second and 1 day');
  const clock = config.now ?? Date.now;

  return async (
    record: TrustedReviewerReadback,
    missionId: string,
    invocationId: string,
  ): Promise<boolean> => {
    try {
      if (!record || typeof record !== 'object' ||
          record.principalId !== config.reviewerPrincipalId ||
          record.receipt?.missionId !== missionId ||
          record.receipt?.executionId !== invocationId ||
          record.receipt?.receiptId !== record.authenticatedReceiptId ||
          record.receipt?.producer.kind !== 'independent-qa' ||
          record.receipt?.verdict !== 'passed' ||
          !SHA.test(record.receipt.artifactDigest) ||
          !SHA.test(record.receipt.criteriaDigest)) return false;
      const issued = Date.parse(record.receipt.issuedAt);
      const now = clock();
      if (!Number.isSafeInteger(now) || !Number.isFinite(issued) ||
          issued > now + 30_000 || now - issued > maxAge) return false;
      const signature = (record as SignedReviewerReadback).signatureBase64;
      if (typeof signature !== 'string' || !BASE64.test(signature) ||
          signature.length > 256) return false;
      const binary = Buffer.from(signature, 'base64');
      if (binary.length !== 64 || binary.toString('base64') !== signature) return false;
      return ed25519Verify(null, Buffer.from(canonical(record), 'utf8'), key, binary);
    } catch {
      return false;
    }
  };
}


/**
 * Production composition: stock Mission QA gate + original InvocationJournal +
 * cryptographically pinned REVIEWER authority. The caller provides original
 * immutable stock observations and external reviewer readback, not permission
 * to bypass signature verification.
 */
export function createPinnedNativeQaReview(
  ports: Omit<IndependentQaAuthorityPorts, 'authenticateReviewer'>,
  trust: PinnedQaVerifierOptions,
) {
  if (ports?.workerPrincipalId === trust?.reviewerPrincipalId) {
    throw new TypeError('the reviewer principal must differ from the Codex worker');
  }
  const authenticateReviewer = createPinnedQaAuthenticator(trust);
  return createNativeAuthorizedQaReview({ ...ports, authenticateReviewer });
}
