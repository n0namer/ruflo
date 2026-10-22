/** Opt-in A55 integration: stock MissionStore/Journal -> installed OS-isolated QA signer. */
import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { ExecutionLeaseStore } from '../../src/missions/execution-lease.js';
import { ExecutionInvocationJournal } from '../../src/missions/execution-invocation-journal.js';
import { createRequestedPinnedNativeQaReview } from '../../src/missions/native-qa-request.js';
import { STOCK_OUTCOME_SCHEMA } from '../../src/missions/execution-quality.js';

const sha = (value:string|Buffer) => 'sha256:'+createHash('sha256').update(value).digest('hex');
const root='D:/Users/NIKITA/Documents/DEV/ruflo-native-m2-qa-canary';
const qa='C:/ProgramData/Ruflo/M2QA';

describe('installed Windows QA service against original Native Mission authority',()=>{
 it.runIf(process.env.RUFLO_ENABLE_INSTALLED_QA_M2==='1')(
 'accepts a real OS-signed receipt only when original MissionStore and journal match',
 async()=>{
  const service=new MissionService({projectRoot:root,channel:'cli',executionAdmission:(view,action)=>{
   const r=root.replace(/\\/g,'/');
   return {action,worktree:{root:r,candidate:r,rooted:true,repositoryId:'isolated-qa-canary',
      sourceStateId:sha('canary-source')},
    policy:{allowed:true,decisionRef:'canary-policy'},
    budget:{allowed:true,reservationRef:'canary-budget',
     estimatedMinor:view.budget!.estimatedMinor,
     remainingMinor:view.budget!.ceilingMinor-view.budget!.reservedMinor-view.budget!.settledMinor-view.budget!.unresolvedMinor},
    permissions:{granted:true,required:['fs.write'],explicit:['fs.write'],authorizationRef:'canary-auth'},
    evidenceRefs:['qa-canary:worktree','qa-canary:policy','qa-canary:budget','qa-canary:permission']};
  }});
  const requestTag=randomUUID();
  const created=await service.create({requestId:'create-'+requestTag,objective:'Verify installed independent QA with Native journal'});
  if(!created.ok)throw Error(created.message);
  const missionId=created.data.missionId;
  const plan={tasks:[{id:'make',title:'Audit fixture code',dependsOn:[],
    executor:{mode:'durable-executor' as const,requirement:'codex'},
    capabilityCeiling:['fs.write'],estimatedCostMinor:10,acceptanceEvidence:['quality']}],
   acceptance:[{id:'quality',check:'independent artifact verification',inputs:[],
     producer:'independent-reviewer',independent:true,mandatory:true}],
   budget:{currency:'USD',ceilingMinor:100},scope:{capabilities:['fs.write']}};
  const planned=await service.plan({requestId:'plan-'+requestTag,missionId,expectedRevision:1,plan});
  if(!planned.ok)throw Error(planned.message);
  const admitted=await service.requestAction({requestId:'admit-'+requestTag,missionId,expectedRevision:2,action:'admit'});
  if(!admitted.ok)throw Error(admitted.message);
  const lease=await new ExecutionLeaseStore(root).claim(missionId,'qa-canary-codex-owner');
  const internal=new MissionService({projectRoot:root,channel:'internal',
   authorizeRuntimeEvent:()=>({authorized:true as const,receiptRef:'qa-canary-runtime-fixture'})});
  const ack=await internal.recordNativeEvent({requestId:'ack-'+requestTag,missionId,expectedRevision:3,
   type:'executor.acknowledged',payload:{executorId:'qa-canary-codex-owner',leaseEpoch:Number(lease.generation)}});
  expect(ack.ok).toBe(true);
  const view=new MissionStore(root).loadView(missionId)!;
  expect(view.record.state).toBe('running');
  const invocationId='inv-installed-'+requestTag;
  const sourceDigest=sha('canary-source');
  const policyDigest=sha('canary-policy');
  const intent={missionId,taskId:'make',invocationId,
    planRevision:view.record.plan.revision,leaseGeneration:lease.generation,
    ownerId:'qa-canary-codex-owner',sessionId:'qa-canary-session',
    policyRef:view.record.policyRef,policyDigest,sourceDigest,
    inputDigest:sha('canary-prompt'),authority:{decisionRef:view.record.authorizationRef!,policyDigest}};
  const journal=new ExecutionInvocationJournal(root);
  expect((await journal.prepare(intent)).status).toBe('prepared');
  expect((await journal.markDispatched(intent,'qa-canary-fixture-dispatch')).status).toBe('dispatched');
  const artifactDigest=sha(readFileSync(join(root,'.claude-flow','probe-artifacts','make.mjs')));
  const dispatch={missionId,taskId:'make',invocationId,status:'completed' as const,
    outcome:'completed' as const,exitCode:0,pid:process.pid,
    threadId:'qa-canary-logical',physicalThreadId:'01a155b3-3e7a-7691-93ce-5301127c18c1',
    settlement:'observation-required' as const,events:[],stdout:'',stderr:''};
  const outcome={schema:STOCK_OUTCOME_SCHEMA,missionId,executionId:invocationId,
    planRevision:view.record.plan.revision,criteriaDigest:view.record.acceptance.criteriaDigest,
    artifactDigest,exitCode:0,status:'succeeded' as const,
    provenance:{source:'stock-mission' as const,missionId,executionId:invocationId,
     planRevision:view.record.plan.revision,artifactDigest},
    observedAt:new Date().toISOString()};
  const publicKeyPem=readFileSync(join(qa,'public','signer.public.pem'),'utf8');
  const review=createRequestedPinnedNativeQaReview({
   projectRoot:root,workerPrincipalId:'qa-canary-codex-owner',
   readStockOutcome:async()=>outcome,
   readArtifactDigest:async()=>sha(readFileSync(join(root,'.claude-flow','probe-artifacts','make.mjs'))),
   readSourceDigest:async()=>sourceDigest,
  },{publicKeyPem,reviewerPrincipalId:'ruflo-m2-qa-signer'},
   {inboxRoot:join(qa,'inbox'),spoolRoot:join(qa,'signed'),timeoutMs:180_000,pollMs:400});
  const accepted=await review('make',dispatch as any,view);
  console.log('INSTALLED_QA_NATIVE_READBACK='+JSON.stringify({missionId,invocationId,
    accepted:accepted?.accepted===true,artifactDigest:accepted?.artifactDigest}));
  expect(accepted).toMatchObject({accepted:true,artifactDigest});
  expect((await journal.get(missionId,invocationId))?.status).toBe('dispatched');
 },220_000);
});
