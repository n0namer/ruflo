import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { ExecutionLeaseStore } from '../../src/missions/execution-lease.js';
import { ExecutionInvocationJournal } from '../../src/missions/execution-invocation-journal.js';
import { createNativeAuthorizedQaReview } from '../../src/missions/native-qa-authority.js';
import { createPinnedNativeQaReview } from '../../src/missions/native-qa-attestation.js';
import { INDEPENDENT_QA_SCHEMA, STOCK_OUTCOME_SCHEMA } from '../../src/missions/execution-quality.js';
import { plan } from './helpers.js';
const hash = (text:string) => 'sha256:'+createHash('sha256').update(text).digest('hex');
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'ruflo-authenticated-qa-'));});
afterEach(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
async function prepared() {
 const svc=new MissionService({projectRoot:root,channel:'cli',executionAdmission:(view,action)=>{
   const r=root.replace(/\\/g,'/');
   return {action,worktree:{root:r,candidate:r,rooted:true,repositoryId:'test-repo',
      sourceStateId:hash('source')},
    policy:{allowed:true,decisionRef:'policy:authoritative'},
    budget:{allowed:true,reservationRef:'budget:verified',estimatedMinor:view.budget!.estimatedMinor,
      remainingMinor:view.budget!.ceilingMinor-view.budget!.reservedMinor-view.budget!.settledMinor-view.budget!.unresolvedMinor},
    permissions:{granted:true,required:['fs.write'],explicit:['fs.write'],
      authorizationRef:'auth:verified'},
    evidenceRefs:['worktree:receipt','policy:receipt','budget:receipt','permission:receipt']};
 }});
 const created=await svc.create({requestId:'new',objective:'Native QA independent receipts'});
 if(!created.ok)throw new Error(created.message);
 const missionId=created.data.missionId;
 const planned=await svc.plan({requestId:'plan',missionId,expectedRevision:1,plan:plan()});
 if(!planned.ok)throw new Error(planned.message);
 const admitted=await svc.requestAction({requestId:'admit',missionId,expectedRevision:2,action:'admit'});
 if(!admitted.ok)throw new Error(admitted.message);
 const lease=await new ExecutionLeaseStore(root).claim(missionId,'stock-codex-worker');
 const internal=new MissionService({projectRoot:root,channel:'internal',
   authorizeRuntimeEvent:()=>({authorized:true as const,receiptRef:'test:original-executor-ack'})});
 const acknowledged=await internal.recordNativeEvent({requestId:'stock-executor-ack',missionId,
   expectedRevision:3,type:'executor.acknowledged',
   payload:{executorId:'stock-codex-worker',leaseEpoch:Number(lease.generation)}});
 expect(acknowledged).toMatchObject({ok:true,data:{state:'running'}});
 const view=new MissionStore(root).loadView(missionId)!;
 const journal=new ExecutionInvocationJournal(root);
 const taskId='produce', invocationId='inv-produce';
 const intent={
   missionId,taskId,invocationId,planRevision:view.record.plan.revision,
   leaseGeneration:lease.generation,ownerId:lease.ownerId,sessionId:'resident-1',
   policyRef:view.record.policyRef,policyDigest:hash('policy'),sourceDigest:hash('source'),
   inputDigest:hash('prompt'),authority:{decisionRef:view.record.authorizationRef!,policyDigest:hash('policy')},
 };
 expect((await journal.prepare(intent)).status).toBe('prepared');
 expect((await journal.markDispatched(intent,'dispatch:original')).status).toBe('dispatched');
 const artifactDigest=hash('file-content');
 const dispatch={
   missionId,taskId,invocationId,status:'completed' as const,outcome:'completed' as const,
   exitCode:0,pid:2233,physicalThreadId:'01a155b3-3e7a-7691-93ce-5301127c18c1',
   threadId:'logical-thread',settlement:'observation-required' as const,
   events:[],stdout:'',stderr:'',
 };
 const outcome={
   schema:STOCK_OUTCOME_SCHEMA,missionId,executionId:invocationId,
   planRevision:view.record.plan.revision,criteriaDigest:view.record.acceptance.criteriaDigest,
   artifactDigest,exitCode:0,status:'succeeded' as const,
   provenance:{source:'stock-mission' as const,missionId,executionId:invocationId,
     planRevision:view.record.plan.revision,artifactDigest},
   observedAt:'2026-10-20T00:00:00.000Z',
 };
 const qa={
   schema:INDEPENDENT_QA_SCHEMA,receiptId:'review-receipt-1',missionId,executionId:invocationId,
   planRevision:view.record.plan.revision,criteriaDigest:view.record.acceptance.criteriaDigest,
   artifactDigest,verdict:'passed' as const,
   producer:{kind:'independent-qa' as const,qaRunId:'independent-review-run'},
   evidenceRef:'qa-evidence-1',issuedAt:'2026-10-20T00:01:00.000Z',
 };
 let authorized=true, actualDigest=artifactDigest, reviewerId='external-code-reviewer', currentSource=hash('source');
 const ports={
   projectRoot:root,workerPrincipalId:'stock-codex-worker',
   readStockOutcome:async()=>outcome,
   readReviewer:async()=>({receipt:qa,principalId:reviewerId,authenticatedReceiptId:qa.receiptId}),
   authenticateReviewer:async()=>authorized,
   readArtifactDigest:async()=>actualDigest,
   readSourceDigest:async()=>currentSource,
 };
 return {view,dispatch,ports,qa,get source(){return currentSource},
   deny(){authorized=false},driftSource(){currentSource=hash('tampered-source')},
   tamperArtifact(){actualDigest=hash('modified-file')},
   forgeWorkerReviewer(){reviewerId='stock-codex-worker'},
   forgePhysicalReviewer(){reviewerId=dispatch.physicalThreadId}};
}
describe('Native trusted independent QA readback (never CLI-supplied)',()=>{
 it('accepts only authentic reviewer, original source and artifact SHA',async()=>{
  const f=await prepared();expect(await createNativeAuthorizedQaReview(f.ports)(
    'produce',f.dispatch as any,f.view)).toMatchObject({
      accepted:true,artifactDigest:hash('file-content'),reviewerRunId:'independent-review-run',
      evidenceId:'review-receipt-1',
    });
 });
 it('accepts a genuinely signed independent reviewer through production QA composition',async()=>{
  const f=await prepared();
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const signedAt=Date.parse('2026-10-20T00:02:00.000Z');
  const reviewerPrincipalId='external-code-reviewer';
  const receipt=f.qa;
  const payload=JSON.stringify([
    'ruflo.m2.qa-attestation/v1',reviewerPrincipalId,receipt.receiptId,
    receipt.schema,receipt.receiptId,receipt.missionId,receipt.executionId,
    receipt.planRevision,receipt.criteriaDigest,receipt.artifactDigest,
    receipt.verdict,receipt.producer.kind,receipt.producer.qaRunId,
    receipt.evidenceRef,receipt.issuedAt,
  ]);
  const signatureBase64=sign(null,Buffer.from(payload),privateKey).toString('base64');
  const readReviewer=async()=>({receipt,principalId:reviewerPrincipalId,
    authenticatedReceiptId:receipt.receiptId,signatureBase64});
  const trust={publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),
    reviewerPrincipalId,now:()=>signedAt,maxReceiptAgeMs:300000};
  const review=createPinnedNativeQaReview({...f.ports,readReviewer},trust);
  expect(await review('produce',f.dispatch as any,f.view))
    .toMatchObject({accepted:true,artifactDigest:receipt.artifactDigest});
  const forged=createPinnedNativeQaReview({...f.ports,readReviewer:async()=>
    ({...await readReviewer(),signatureBase64:'A'.repeat(88)})},trust);
  expect(await forged('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines unauthenticated reviewer even with perfect-looking QA receipt',async()=>{
  const f=await prepared();f.deny();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines reviewer with same principal as Codex worker',async()=>{
  const f=await prepared();f.forgeWorkerReviewer();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines reviewer using same physical Codex thread identity',async()=>{
  const f=await prepared();f.forgePhysicalReviewer();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines journal owned by a different Codex worker',async()=>{
  const f=await prepared();
  expect(await createNativeAuthorizedQaReview({...f.ports,workerPrincipalId:'another-worker'})
    ('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines source drift without journal mutation or new dispatch',async()=>{
  const f=await prepared();f.driftSource();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('declines file bytes changed after claimed independent QA hash',async()=>{
  const f=await prepared();f.tamperArtifact();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',f.dispatch as any,f.view)).toBeNull();
 });
 it('rejects fake successful process without stock terminal-ready receipt',async()=>{
  const f=await prepared();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',{...f.dispatch,exitCode:1} as any,f.view)).toBeNull();
 });
 it('rejects mismatched Mission/plan identity or bad reviewer attestation linkage',async()=>{
  const f=await prepared();
  expect(await createNativeAuthorizedQaReview(f.ports)('produce',{...f.dispatch,missionId:'msn_wrong'} as any,f.view)).toBeNull();
  expect(await createNativeAuthorizedQaReview({...f.ports,
    readReviewer:async()=>({receipt:f.qa,principalId:'qa',authenticatedReceiptId:'forged'})}
  )('produce',f.dispatch as any,f.view)).toBeNull();
 });
});
