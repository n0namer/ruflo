import { describe, expect, it } from 'vitest';
import {
  INDEPENDENT_QA_SCHEMA,
  STOCK_OUTCOME_SCHEMA,
  validateIndependentQaReceipt,
  verifyStockMissionOutcome,
} from '../../src/missions/execution-quality.js';

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const baseOutcome = () => ({
  schema: STOCK_OUTCOME_SCHEMA,
  missionId: 'mission-1',
  executionId: 'exec-1',
  planRevision: 3,
  criteriaDigest: digest('a'),
  artifactDigest: digest('b'),
  exitCode: 0,
  status: 'succeeded',
  provenance: {
    source: 'stock-mission',
    missionId: 'mission-1',
    executionId: 'exec-1',
    planRevision: 3,
    artifactDigest: digest('b'),
  },
  observedAt: '2026-10-11T12:00:00.000Z',
});
const baseQa = () => ({
  schema: INDEPENDENT_QA_SCHEMA,
  receiptId: 'qa-receipt-1',
  missionId: 'mission-1',
  executionId: 'exec-1',
  planRevision: 3,
  criteriaDigest: digest('a'),
  artifactDigest: digest('b'),
  verdict: 'passed',
  producer: { kind: 'independent-qa', qaRunId: 'qa-run-1' },
  evidenceRef: 'evidence-1',
  issuedAt: '2026-10-11T12:01:00.000Z',
});

describe('stock Mission execution quality gate', () => {
  it('accepts a successful stock outcome only with matching independent QA', () => {
    const result = verifyStockMissionOutcome(baseOutcome(), baseQa());
    expect(result.accepted).toBe(true);
    expect(result.qa.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects exit code 0 without a successful outcome and QA receipt', () => {
    const outcome = baseOutcome();
    delete (outcome as Record<string, unknown>).status;
    const result = verifyStockMissionOutcome(outcome, undefined);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join('; ')).toMatch(/status|QA/);
  });

  it('rejects a non-zero exit even if a forged success status and QA are supplied', () => {
    const outcome = { ...baseOutcome(), exitCode: 7 };
    const result = verifyStockMissionOutcome(outcome, baseQa());
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('exitCode'))).toBe(true);
  });

  it('fails closed when outcome provenance is changed', () => {
    const outcome = {
      ...baseOutcome(),
      provenance: { ...baseOutcome().provenance, missionId: 'other-mission' },
    };
    const result = verifyStockMissionOutcome(outcome, baseQa());
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('provenance missionId'))).toBe(true);
  });

  it('fails closed when QA is not independent from the stock execution', () => {
    const qa = { ...baseQa(), producer: { kind: 'stock-mission', qaRunId: 'exec-1' } };
    const result = verifyStockMissionOutcome(baseOutcome(), qa);
    expect(result.accepted).toBe(false);
    expect(result.qa.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('independent QA'))).toBe(true);
  });

  it('rejects a QA receipt with unknown fields instead of accepting signed-looking data', () => {
    const qa = { ...baseQa(), attestation: 'trusted' };
    const result = validateIndependentQaReceipt(qa);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('unknown field'))).toBe(true);
  });

  it('rejects a failed QA verdict even when outcome and provenance otherwise match', () => {
    const result = verifyStockMissionOutcome(baseOutcome(), { ...baseQa(), verdict: 'failed' });
    expect(result.accepted).toBe(false);
    expect(result.qa.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('verdict is not passed'))).toBe(true);
  });

  it('rejects mismatched artifact, criteria, and plan provenance', () => {
    const qa = {
      ...baseQa(),
      planRevision: 4,
      criteriaDigest: digest('c'),
      artifactDigest: digest('d'),
    };
    const result = verifyStockMissionOutcome(baseOutcome(), qa);
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('planRevision'))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes('criteriaDigest'))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes('artifactDigest'))).toBe(true);
  });

  it('rejects impossible calendar dates despite matching timestamp syntax', () => {
    const result = verifyStockMissionOutcome(
      { ...baseOutcome(), observedAt: '2026-99-99T12:00:00.000Z' },
      baseQa(),
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('canonical UTC date'))).toBe(true);
  });

  it('rejects inherited authority fields instead of trusting prototype data', () => {
    const outcome = Object.create(baseOutcome()) as Record<string, unknown>;
    const result = verifyStockMissionOutcome(outcome, baseQa());
    expect(result.accepted).toBe(false);
    expect(result.reasons.join('; ')).toMatch(/Mission outcome must be an object/);
  });

  it('does not mutate either receipt or outcome and exposes no terminal transition', () => {
    const outcome = baseOutcome();
    const qa = baseQa();
    const before = JSON.stringify({ outcome, qa });
    const result = verifyStockMissionOutcome(outcome, qa);
    expect(result.accepted).toBe(true);
    expect(JSON.stringify({ outcome, qa })).toBe(before);
    expect('terminalState' in result).toBe(false);
  });
});
