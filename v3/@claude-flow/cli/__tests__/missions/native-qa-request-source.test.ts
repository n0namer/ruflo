import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestedPinnedNativeQaReview } from '../../src/missions/native-qa-request.js';

const missionId = 'msn_aaaaaaaaaaaaaaaaaaaaaaaa';
const invocationId = 'inv-source-bound';
const sha = (char: string) => 'sha256:' + char.repeat(64);
let base: string, project: string, inbox: string, spool: string;
beforeEach(() => {
  base=mkdtempSync(join(tmpdir(),'ruflo-source-bound-'));
  project=join(base,'codex-workspace');
  inbox=join(base,'qa-inbox');
  spool=join(base,'external-spool');
  [project,inbox,spool].forEach(dir=>mkdirSync(dir,{recursive:true}));
});
afterEach(()=>rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:80}));
function review(sourceDigest: string | null, overrides: any = {}) {
  const ports = {
    projectRoot: project, workerPrincipalId:'codex-worker',
    readStockOutcome:async()=>null,readReviewer:async()=>null,
    readArtifactDigest:async()=>null,readSourceDigest:async()=>sourceDigest,
    ...overrides,
  };
  // Trust is never exercised without a signed receipt; a real Ed25519 SPKI
  // is used only for constructor validity, not a mock accept callback.
  const publicKeyPem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAuoZyk1OvYVaJHhI2WIO/Gkn39NAKe23XiO6pDfRmbxY=\n-----END PUBLIC KEY-----';
  return createRequestedPinnedNativeQaReview(ports, {
    publicKeyPem,reviewerPrincipalId:'external-reviewer',now:()=>Date.now(),
  },{inboxRoot:inbox,spoolRoot:spool,timeoutMs:500,pollMs:25});
}
const dispatch = {
  missionId,invocationId,taskId:'make',status:'completed',exitCode:0,
};
const view = {
  record:{missionId,state:'running',plan:{revision:3},acceptance:{criteriaDigest:sha('b')}},
};
describe('QA request source digest bound to the stock Mission',()=>{
  it('rejects nested inbox and signed spool roots to preserve separate ACL ownership',()=>{
    const nested=join(inbox,'signed');
    mkdirSync(nested,{recursive:true});
    const ports={projectRoot:project,workerPrincipalId:'codex-worker',readStockOutcome:async()=>null,readArtifactDigest:async()=>null,readSourceDigest:async()=>sha('a')};
    const publicKeyPem='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAuoZyk1OvYVaJHhI2WIO/Gkn39NAKe23XiO6pDfRmbxY=\n-----END PUBLIC KEY-----';
    const trust={publicKeyPem,reviewerPrincipalId:'external-reviewer',now:()=>Date.now()};
    expect(()=>createRequestedPinnedNativeQaReview(ports as any,trust,{inboxRoot:inbox,spoolRoot:nested})).toThrow();
  });
  it('emits exact authoritative SHA in immutable external QA request',async()=>{
    const r=review(sha('a'));
    expect(await r('make',dispatch as any,view as any)).toBeNull();
    const name=missionId+'--'+invocationId+'.request.json';
    const request=JSON.parse(readFileSync(join(inbox,name),'utf8'));
    expect(request).toMatchObject({
      missionId,invocationId,sourceDigest:sha('a'),
      criteriaDigest:sha('b'),planRevision:3,
    });
  });
  it('refuses missing and malformed source SHA without writing request',async()=>{
    for(const value of [null,'sha256:123','attacker',sha('A')]) {
      expect(await review(value)('make',dispatch as any,view as any)).toBeNull();
    }
    const {readdirSync}=await import('node:fs');
    expect(readdirSync(inbox)).toEqual([]);
  });
  it('refuses a pre-existing request pinned to a stale SHA',async()=>{
    const name=missionId+'--'+invocationId+'.request.json';
    const target=join(inbox,name);
    writeFileSync(target,JSON.stringify({missionId,invocationId,taskId:'make',
      workspaceRoot:project,planRevision:3,criteriaDigest:sha('b'),sourceDigest:sha('c')})+'\n');
    expect(await review(sha('a'))('make',dispatch as any,view as any)).toBeNull();
    const persisted=JSON.parse(readFileSync(target,'utf8'));
    expect(persisted.sourceDigest).toBe(sha('c'));
  });
});
