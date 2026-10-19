import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExternalReviewerReadback, createExternallyReviewedNativeM2FactoryDriver } from '../../src/missions/native-qa-external-readback.js';
import { createPinnedQaAuthenticator } from '../../src/missions/native-qa-attestation.js';
import { INDEPENDENT_QA_SCHEMA } from '../../src/missions/execution-quality.js';

const signer = fileURLToPath(new URL('./fixtures/qa-external-signer-fixture.mjs',import.meta.url));
let base: string, worker: string, spool: string, privateKeyFile: string, publicKeyPem: string;
const missionId='msn_aaaaaaaaaaaaaaaaaaaaaaaa', invocationId='inv-1';
const evidence = () => ({
  principalId:'external-qa-service',
  authenticatedReceiptId:'external-review-receipt',
  receipt:{
    schema:INDEPENDENT_QA_SCHEMA,receiptId:'external-review-receipt',
    missionId,executionId:invocationId,planRevision:1,
    criteriaDigest:'sha256:'+'a'.repeat(64),artifactDigest:'sha256:'+'b'.repeat(64),
    verdict:'passed' as const,
    producer:{kind:'independent-qa' as const,qaRunId:'external-review-run-1'},
    evidenceRef:'external-proof-1',issuedAt:'2026-10-20T00:01:00.000Z',
  },
});
beforeEach(()=>{
  base=mkdtempSync(join(tmpdir(),'ruflo-qa-transport-'));
  worker=join(base,'codex-worker');spool=join(base,'independent-qa');
  mkdirSync(worker);mkdirSync(spool);
  const keys=generateKeyPairSync('ed25519');
  privateKeyFile=join(base,'TEST_ONLY-private.pem');
  writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}));
  publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
});
afterEach(()=>rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:150}));
function issue() {
  const claimFile=join(base,'fixture-review-claim.json');
  writeFileSync(claimFile,JSON.stringify(evidence()));
  const out=execFileSync(process.execPath,[signer,claimFile,privateKeyFile,spool],{
    encoding:'utf8',timeout:7000,windowsHide:true,
  });
  expect(out).toContain('TEST_ONLY_EXTERNAL_REVIEWER_RECEIPT_WRITTEN');
  return join(spool,missionId,invocationId+'.signed.json');
}
describe('read-only independent reviewer receipt transport',()=>{
  it('reads a separately signed process result, then pinned Ed25519 verifies it',async()=>{
    issue();
    const read=createExternalReviewerReadback(worker,spool);
    const result=await read(missionId,invocationId);
    expect(result).toMatchObject(evidence());
    const auth=createPinnedQaAuthenticator({
      publicKeyPem,reviewerPrincipalId:'external-qa-service',
      now:()=>Date.parse('2026-10-20T00:02:00.000Z'),
    });
    expect(await auth(result!,missionId,invocationId)).toBe(true);
  });
  it('accepts no forged status or signature even if the file can be replaced',async()=>{
    const file=issue();
    const read=createExternalReviewerReadback(worker,spool);
    const auth=createPinnedQaAuthenticator({
      publicKeyPem,reviewerPrincipalId:'external-qa-service',
      now:()=>Date.parse('2026-10-20T00:02:00.000Z'),
    });
    const content=JSON.parse(readFileSync(file,'utf8'));
    content.receipt.artifactDigest='sha256:'+'c'.repeat(64);
    writeFileSync(file,JSON.stringify(content));
    const forged=await read(missionId,invocationId);
    expect(forged).not.toBeNull();
    expect(await auth(forged!,missionId,invocationId)).toBe(false);
  });
  it('disallows reviewer spool inside worker workspace or enclosing it',()=>{
    expect(()=>createExternalReviewerReadback(worker,join(worker,'qa'))).toThrow();
    expect(()=>createExternalReviewerReadback(worker,base)).toThrow('overlap');
  });
  it('rejects unknown IDs, path traversal, missing files and oversized receipts',async()=>{
    const file=issue();
    const read=createExternalReviewerReadback(worker,spool);
    expect(await read(missionId,'../evil')).toBeNull();
    expect(await read('msn_invalid',invocationId)).toBeNull();
    expect(await read(missionId,'missing')).toBeNull();
    writeFileSync(file,'x'.repeat(20000));
    expect(await read(missionId,invocationId)).toBeNull();
  });
  it('production driver constructor refuses worker=QA identity or an absent external reviewer',()=>{
    const ports:any={
      projectRoot:worker,executorId:'codex-worker',cycleId:'qa-only-m2',
      runtime:{recordNativeEvent:async()=>({ok:false,code:'executor-unavailable'})},
      dispatch:async()=>{throw Error('must-not-launch')},
      settle:async()=>false,
      qa:{workerPrincipalId:'different-worker',readStockOutcome:async()=>null,
        readArtifactDigest:async()=>null,readSourceDigest:async()=>null},
    };
    const trust={publicKeyPem,reviewerPrincipalId:'external-qa-service',
      now:()=>Date.parse('2026-10-20T00:02:00.000Z')};
    expect(()=>createExternallyReviewedNativeM2FactoryDriver(ports,spool,trust)).toThrow('owner');
    ports.qa.workerPrincipalId='codex-worker';
    expect(()=>createExternallyReviewedNativeM2FactoryDriver(
      ports,join(base,'missing-spool'),trust)).toThrow();
    const driver=createExternallyReviewedNativeM2FactoryDriver(ports,spool,trust);
    expect(driver.readMission).toBeTypeOf('function');
    expect(driver.runOnce).toBeTypeOf('function');
    // No Mission was created; the driver cannot fabricate one.
    return expect(driver.readMission({projectRoot:worker,missionId})).resolves.toBeNull();
  });
  it('requires an already-provisioned independent QA spool at bootstrap',()=>{
    expect(()=>createExternalReviewerReadback(worker,join(base,'not-provisioned'))).toThrow();
  });
});
