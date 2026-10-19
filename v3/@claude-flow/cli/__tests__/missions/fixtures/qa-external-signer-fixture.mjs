// TEST ONLY. Not a production QA signer: it deliberately trusts fixture input.
// Real independent reviewer must verify source/tests under another OS identity.
import { sign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [receiptFile,privateKeyFile,spoolRoot] = process.argv.slice(2);
const body = JSON.parse(readFileSync(receiptFile,'utf8'));
const receipt = body.receipt;
const canonical = JSON.stringify([
  'ruflo.m2.qa-attestation/v1',body.principalId,body.authenticatedReceiptId,
  receipt.schema,receipt.receiptId,receipt.missionId,receipt.executionId,
  receipt.planRevision,receipt.criteriaDigest,receipt.artifactDigest,
  receipt.verdict,receipt.producer.kind,receipt.producer.qaRunId,
  receipt.evidenceRef,receipt.issuedAt,
]);
const signatureBase64 = sign(null,Buffer.from(canonical),
  createPrivateKey(readFileSync(privateKeyFile))).toString('base64');
const destination=join(spoolRoot,receipt.missionId);
mkdirSync(destination,{recursive:true});
writeFileSync(join(destination,receipt.executionId+'.signed.json'),
  JSON.stringify({...body,signatureBase64}));
console.log('TEST_ONLY_EXTERNAL_REVIEWER_RECEIPT_WRITTEN');
