/**
 * Read-only, external reviewer transport for ADR-406 M2.
 *
 * Reviewer spool is provisioned and owned by an INDEPENDENT service account,
 * outside any worker workspace. This module never writes receipts, handles a
 * signing key, executes user code or trusts a reviewer's JSON verdict.
 * The stock pinned Ed25519 + MissionStore/journal/source gates validate it.
 */
import { constants } from 'node:fs';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createPinnedNativeQaReview } from './native-qa-attestation.js';
import type { SignedReviewerReadback, PinnedQaVerifierOptions } from './native-qa-attestation.js';
import type { IndependentQaAuthorityPorts } from './native-qa-authority.js';
import { createNativeM2FactoryDriver } from './native-factory-driver.js';
import type { TrustedNativeM2Ports } from './native-factory-driver.js';

const MISSION = /^msn_[a-f0-9]{24}$/;
const INVOCATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 16_384;

const normalized = (value: string) => {
  const canonical = realpathSync(resolve(value));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};

export function createExternalReviewerReadback(
  projectRoot: string, externalSpoolRoot: string,
): (missionId: string, invocationId: string) => Promise<SignedReviewerReadback | null> {
  if (!projectRoot || !externalSpoolRoot) throw new TypeError('explicit project and external QA spool are required');
  const project = normalized(projectRoot);
  const spool = normalized(externalSpoolRoot);
  // Independent reviewer ownership MUST be represented by a distinct OS
  // account/ACL. The spool may not overlap with any Codex writer workspace.
  if (within(project, spool) || within(spool, project)) {
    throw new TypeError('external QA spool must not overlap the worker workspace');
  }
  return async (missionId: string, invocationId: string) => {
    if (!MISSION.test(missionId) || !INVOCATION.test(invocationId)) return null;
    let fd: number | undefined;
    try {
      const directory = join(spool, missionId);
      const file = join(directory, invocationId + '.signed.json');
      if (lstatSync(directory).isSymbolicLink() || lstatSync(file).isSymbolicLink()) return null;
      // The path must still be inside the independent spool after canonicalization.
      if (!within(spool, normalized(directory)) || !within(spool, normalized(file))) return null;
      fd = openSync(file, constants.O_RDONLY);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) return null;
      const data = JSON.parse(readFileSync(fd, { encoding: 'utf8' })) as SignedReviewerReadback;
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          data.receipt?.missionId !== missionId || data.receipt?.executionId !== invocationId ||
          data.authenticatedReceiptId !== data.receipt?.receiptId ||
          typeof data.signatureBase64 !== 'string') return null;
      return data;
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}


/** Production reader composition; caller cannot substitute authenticateReviewer. */
export function createExternalPinnedNativeQaReview(
  ports: Omit<IndependentQaAuthorityPorts, 'readReviewer' | 'authenticateReviewer'>,
  spoolRoot: string,
  trust: PinnedQaVerifierOptions,
) {
  const readReviewer = createExternalReviewerReadback(ports.projectRoot, spoolRoot);
  return createPinnedNativeQaReview({ ...ports, readReviewer }, trust);
}


/**
 * Fail-closed production factory bootstrap: the caller may provide Codex and
 * journal ports, but cannot inject a self-approving review callback. Reviewer
 * evidence is always read from the independent spool and signature-checked.
 */
export interface ExternalQaResidentPorts extends Omit<TrustedNativeM2Ports, 'review'> {
  readonly qa: Pick<IndependentQaAuthorityPorts,
    'workerPrincipalId' | 'readStockOutcome' | 'readArtifactDigest' | 'readSourceDigest'>;
}
export function createExternallyReviewedNativeM2FactoryDriver(
  ports: ExternalQaResidentPorts,
  spoolRoot: string,
  trust: PinnedQaVerifierOptions,
) {
  if (!ports || ports.executorId !== ports.qa?.workerPrincipalId) {
    throw new TypeError('Native worker owner and independent QA journal owner must match');
  }
  const { qa, ...driverPorts } = ports;
  const review = createExternalPinnedNativeQaReview({
    ...qa, projectRoot: ports.projectRoot,
  }, spoolRoot, trust);
  return createNativeM2FactoryDriver({ ...driverPorts, review });
}
