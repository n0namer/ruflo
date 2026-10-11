/**
 * Strict stock Mission outcome verification.
 *
 * This module is deliberately side-effect free: it produces a verification
 * decision and never changes mission/native task state. A stock execution
 * outcome is only eligible when its provenance is bound to the exact mission
 * revision and artifact, and an independent QA receipt verifies that artifact.
 *
 * Exit code 0 is necessary for a successful stock execution, but is never
 * sufficient evidence of mission success.
 */

export const STOCK_OUTCOME_SCHEMA = 'ruflo.stock-mission-outcome/v1' as const;
export const INDEPENDENT_QA_SCHEMA = 'ruflo.independent-mission-qa/v1' as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface StockMissionOutcome {
  readonly schema: typeof STOCK_OUTCOME_SCHEMA;
  readonly missionId: string;
  readonly executionId: string;
  readonly planRevision: number;
  readonly criteriaDigest: string;
  readonly artifactDigest: string;
  readonly exitCode: number;
  readonly status: 'succeeded' | 'failed';
  readonly provenance: {
    readonly source: 'stock-mission';
    readonly missionId: string;
    readonly executionId: string;
    readonly planRevision: number;
    readonly artifactDigest: string;
  };
  readonly observedAt: string;
}

export interface IndependentQaReceipt {
  readonly schema: typeof INDEPENDENT_QA_SCHEMA;
  readonly receiptId: string;
  readonly missionId: string;
  readonly executionId: string;
  readonly planRevision: number;
  readonly criteriaDigest: string;
  readonly artifactDigest: string;
  readonly verdict: 'passed' | 'failed';
  readonly producer: {
    readonly kind: 'independent-qa';
    readonly qaRunId: string;
  };
  readonly evidenceRef: string;
  readonly issuedAt: string;
}

export interface QaReceiptValidation {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

export interface MissionOutcomeVerification {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly qa: QaReceiptValidation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function requiredDate(value: unknown, path: string, reasons: string[]): value is string {
  if (!isCanonicalDate(value)) {
    reasons.push(`${path} must be a canonical UTC date`);
    return false;
  }
  return true;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): string[] {
  const allowed = new Set(keys);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${path} has unknown field ${key}`);
}

function requiredString(value: unknown, pattern: RegExp, path: string, reasons: string[]): value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    reasons.push(`${path} must be a canonical string`);
    return false;
  }
  return true;
}

function requiredInteger(value: unknown, path: string, reasons: string[]): value is number {
  if (!Number.isSafeInteger(value)) {
    reasons.push(`${path} must be a safe integer`);
    return false;
  }
  return true;
}

function validateQaShape(raw: unknown): { receipt?: IndependentQaReceipt; reasons: string[] } {
  const reasons: string[] = [];
  if (!isRecord(raw)) return { reasons: ['QA receipt must be an object'] };
  reasons.push(...exactKeys(raw, [
    'schema', 'receiptId', 'missionId', 'executionId', 'planRevision',
    'criteriaDigest', 'artifactDigest', 'verdict', 'producer', 'evidenceRef', 'issuedAt',
  ], 'QA receipt'));

  if (raw.schema !== INDEPENDENT_QA_SCHEMA) reasons.push('QA receipt schema is not the independent Mission QA schema');
  const receiptId = requiredString(raw.receiptId, ID, 'QA receipt receiptId', reasons) ? raw.receiptId : '';
  const missionId = requiredString(raw.missionId, ID, 'QA receipt missionId', reasons) ? raw.missionId : '';
  const executionId = requiredString(raw.executionId, ID, 'QA receipt executionId', reasons) ? raw.executionId : '';
  const planRevision = requiredInteger(raw.planRevision, 'QA receipt planRevision', reasons) ? raw.planRevision : -1;
  if (planRevision < 1) reasons.push('QA receipt planRevision must be positive');
  const criteriaDigest = requiredString(raw.criteriaDigest, DIGEST, 'QA receipt criteriaDigest', reasons) ? raw.criteriaDigest : '';
  const artifactDigest = requiredString(raw.artifactDigest, DIGEST, 'QA receipt artifactDigest', reasons) ? raw.artifactDigest : '';
  if (raw.verdict !== 'passed' && raw.verdict !== 'failed') reasons.push('QA receipt verdict is invalid');
  if (!requiredString(raw.evidenceRef, ID, 'QA receipt evidenceRef', reasons)) { /* recorded above */ }
  requiredDate(raw.issuedAt, 'QA receipt issuedAt', reasons);

  let producer: IndependentQaReceipt['producer'] | undefined;
  if (!isRecord(raw.producer)) {
    reasons.push('QA receipt producer must be an object');
  } else {
    reasons.push(...exactKeys(raw.producer, ['kind', 'qaRunId'], 'QA receipt producer'));
    if (raw.producer.kind !== 'independent-qa') reasons.push('QA receipt producer is not independent QA');
    const qaRunId = requiredString(raw.producer.qaRunId, ID, 'QA receipt producer.qaRunId', reasons)
      ? raw.producer.qaRunId : '';
    producer = { kind: 'independent-qa', qaRunId };
  }

  if (reasons.length === 0) {
    return {
      receipt: {
        schema: INDEPENDENT_QA_SCHEMA,
        receiptId, missionId, executionId, planRevision, criteriaDigest, artifactDigest,
        verdict: raw.verdict as IndependentQaReceipt['verdict'],
        producer: producer!,
        evidenceRef: raw.evidenceRef as string,
        issuedAt: raw.issuedAt as string,
      },
      reasons,
    };
  }
  return { reasons };
}

/**
 * Validate the receipt's structural and semantic contract only. The producer
 * fields are caller-supplied claims, not proof of authority: Native terminal
 * integration must independently authenticate and retrieve QA evidence from a
 * trusted reviewer authority before recording any terminal state.
 */
export function validateIndependentQaReceipt(raw: unknown): QaReceiptValidation {
  const parsed = validateQaShape(raw);
  const reasons = [...parsed.reasons];
  if (parsed.receipt?.producer.qaRunId === parsed.receipt?.executionId) {
    reasons.push('independent QA run must differ from stock execution');
  }
  if (parsed.receipt && parsed.receipt.verdict !== 'passed') {
    reasons.push('QA receipt verdict is not passed');
  }
  return { valid: reasons.length === 0 && parsed.receipt?.verdict === 'passed', reasons };
}

function validateOutcome(raw: unknown): { outcome?: StockMissionOutcome; reasons: string[] } {
  const reasons: string[] = [];
  if (!isRecord(raw)) return { reasons: ['Mission outcome must be an object'] };
  reasons.push(...exactKeys(raw, [
    'schema', 'missionId', 'executionId', 'planRevision', 'criteriaDigest',
    'artifactDigest', 'exitCode', 'status', 'provenance', 'observedAt',
  ], 'Mission outcome'));

  if (raw.schema !== STOCK_OUTCOME_SCHEMA) reasons.push('Mission outcome schema is not the stock Mission schema');
  const missionId = requiredString(raw.missionId, ID, 'Mission outcome missionId', reasons) ? raw.missionId : '';
  const executionId = requiredString(raw.executionId, ID, 'Mission outcome executionId', reasons) ? raw.executionId : '';
  const planRevision = requiredInteger(raw.planRevision, 'Mission outcome planRevision', reasons) ? raw.planRevision : -1;
  if (planRevision < 1) reasons.push('Mission outcome planRevision must be positive');
  const criteriaDigest = requiredString(raw.criteriaDigest, DIGEST, 'Mission outcome criteriaDigest', reasons) ? raw.criteriaDigest : '';
  const artifactDigest = requiredString(raw.artifactDigest, DIGEST, 'Mission outcome artifactDigest', reasons) ? raw.artifactDigest : '';
  if (!Number.isSafeInteger(raw.exitCode) || (raw.exitCode as number) < 0) reasons.push('Mission outcome exitCode must be a non-negative safe integer');
  if (raw.status !== 'succeeded' && raw.status !== 'failed') reasons.push('Mission outcome status is invalid');
  requiredDate(raw.observedAt, 'Mission outcome observedAt', reasons);

  let provenance: StockMissionOutcome['provenance'] | undefined;
  if (!isRecord(raw.provenance)) {
    reasons.push('Mission outcome provenance must be an object');
  } else {
    reasons.push(...exactKeys(raw.provenance, [
      'source', 'missionId', 'executionId', 'planRevision', 'artifactDigest',
    ], 'Mission outcome provenance'));
    if (raw.provenance.source !== 'stock-mission') reasons.push('Mission outcome provenance source is not stock-mission');
    const pMissionId = requiredString(raw.provenance.missionId, ID, 'Mission outcome provenance.missionId', reasons) ? raw.provenance.missionId : '';
    const pExecutionId = requiredString(raw.provenance.executionId, ID, 'Mission outcome provenance.executionId', reasons) ? raw.provenance.executionId : '';
    const pPlanRevision = requiredInteger(raw.provenance.planRevision, 'Mission outcome provenance.planRevision', reasons) ? raw.provenance.planRevision : -1;
    const pArtifactDigest = requiredString(raw.provenance.artifactDigest, DIGEST, 'Mission outcome provenance.artifactDigest', reasons) ? raw.provenance.artifactDigest : '';
    provenance = { source: 'stock-mission', missionId: pMissionId, executionId: pExecutionId, planRevision: pPlanRevision, artifactDigest: pArtifactDigest };
  }

  if (reasons.length === 0) {
    return {
      outcome: {
        schema: STOCK_OUTCOME_SCHEMA, missionId, executionId, planRevision, criteriaDigest,
        artifactDigest, exitCode: raw.exitCode as number, status: raw.status as StockMissionOutcome['status'],
        provenance: provenance!, observedAt: raw.observedAt as string,
      },
      reasons,
    };
  }
  return { reasons };
}

/**
 * The only success gate for a stock Mission execution. It never performs a
 * terminal transition; callers must separately decide how to record this result.
 */
export function verifyStockMissionOutcome(rawOutcome: unknown, rawQaReceipt: unknown): MissionOutcomeVerification {
  const parsedOutcome = validateOutcome(rawOutcome);
  const reasons = [...parsedOutcome.reasons];
  const qa = validateIndependentQaReceipt(rawQaReceipt);

  if (!parsedOutcome.outcome) {
    return { accepted: false, reasons: [...reasons, ...qa.reasons.map((reason) => `QA: ${reason}`)], qa };
  }

  const outcome = parsedOutcome.outcome;
  const p = outcome.provenance;
  if (p.missionId !== outcome.missionId) reasons.push('Mission outcome provenance missionId mismatch');
  if (p.executionId !== outcome.executionId) reasons.push('Mission outcome provenance executionId mismatch');
  if (p.planRevision !== outcome.planRevision) reasons.push('Mission outcome provenance planRevision mismatch');
  if (p.artifactDigest !== outcome.artifactDigest) reasons.push('Mission outcome provenance artifactDigest mismatch');
  if (outcome.status !== 'succeeded') reasons.push('Mission outcome status is not succeeded');
  if (outcome.exitCode !== 0) reasons.push('Mission outcome exitCode is not zero');

  const qaReceipt = validateQaShape(rawQaReceipt).receipt;
  if (!qa.valid) reasons.push(...qa.reasons.map((reason) => `QA: ${reason}`));
  if (qaReceipt) {
    if (qaReceipt.missionId !== outcome.missionId) reasons.push('QA receipt missionId does not match outcome');
    if (qaReceipt.executionId !== outcome.executionId) reasons.push('QA receipt executionId does not match outcome');
    if (qaReceipt.planRevision !== outcome.planRevision) reasons.push('QA receipt planRevision does not match outcome');
    if (qaReceipt.criteriaDigest !== outcome.criteriaDigest) reasons.push('QA receipt criteriaDigest does not match outcome');
    if (qaReceipt.artifactDigest !== outcome.artifactDigest) reasons.push('QA receipt artifactDigest does not match outcome');
  }

  return { accepted: reasons.length === 0, reasons, qa };
}

/** Compatibility aliases keep the contract discoverable without adding side effects. */
export const verifyMissionOutcome = verifyStockMissionOutcome;
export const validateQaReceipt = validateIndependentQaReceipt;
export const canCompleteMission = (outcome: unknown, qaReceipt: unknown): boolean =>
  verifyStockMissionOutcome(outcome, qaReceipt).accepted;
