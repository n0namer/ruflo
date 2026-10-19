import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionService } from '../../src/missions/service.js';
import { createNativeM2FactoryDriver } from '../../src/missions/native-factory-driver.js';
import { plan } from './helpers.js';
const digest = (input:string) => 'sha256:' + createHash('sha256').update(input).digest('hex');
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'ruflo-factory-driver-'));});
afterEach(()=>rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:50}));
async function prepared() {
  const runtime=new MissionService({projectRoot:root,channel:'internal',
    executionAdmission:(view,action)=>{
      const path=root.replace(/\\/g,'/');
      return {action, worktree:{root:path,candidate:path,rooted:true,repositoryId:'fixture',sourceStateId:digest('source')},
        policy:{allowed:true,decisionRef:'policy:fixture'},
        budget:{allowed:true,reservationRef:'budget:fixture',estimatedMinor:view.budget!.estimatedMinor,
          remainingMinor:view.budget!.ceilingMinor-view.budget!.settledMinor-view.budget!.reservedMinor-view.budget!.unresolvedMinor},
        permissions:{granted:true,required:['fs.write'],explicit:['fs.write'],authorizationRef:'auth:fixture'},
        evidenceRefs:['worktree:fixture','policy:fixture','budget:fixture','permission:fixture']};
    },
    authorizeRuntimeEvent:(_view,type)=>({
      authorized:true,receiptRef:'trusted:fixture',
      ...(type==='evidence.recorded'?{independentQa:true as const}:{})
    }),
  });
  const created=await runtime.create({requestId:'new',objective:'Native driver real MissionStore test'});
  if(!created.ok)throw Error(created.message);
  const missionId=created.data.missionId;
  const planned=await runtime.plan({requestId:'plan',missionId,expectedRevision:1,plan:plan()});
  if(!planned.ok)throw Error(planned.message);
  const admitted=await runtime.requestAction({requestId:'admit',missionId,expectedRevision:2,action:'admit'});
  if(!admitted.ok)throw Error(admitted.message);
  let launched=0;
  const driver=createNativeM2FactoryDriver({
    projectRoot:root,runtime,cycleId:'factory-m2-candidate',executorId:'verified-native-host',
    async dispatch(taskId) {
      launched++;
      return {status:'observed',reason:'process-observed-independent-qa-required',receipt:{
        status:'completed',invocationId:'inv-'+taskId,physicalThreadId:'01a155b3-3e7a-7691-93ce-5301127c18c1',
        pid:1234+launched,threadId:'thread-'+taskId,
      }} as any;
    },
    async review(taskId) {return {
      accepted:true as const,artifactDigest:digest('accepted-artifact'),
      evidenceId:'evidence-'+taskId,reviewerRunId:'independent-qa-'+taskId,
    };},
    async settle() {return true;},
  });
  return {driver,missionId,get launched(){return launched}};
}
describe('M2 factory driver binds existing MissionStore and READY cycle',()=>{
 it('rejects foreign workspace / absent registered runtime before any launch',async()=>{
   const f=await prepared();
   expect(await f.driver.readMission({projectRoot:root+'-other',missionId:f.missionId})).toBeNull();
   expect(await f.driver.runOnce({projectRoot:root+'-other',missionId:f.missionId,maxTasks:1,
     beforeDispatch:()=>true})).toMatchObject({status:'blocked',reason:'untrusted-native-request'});
   expect(f.launched).toBe(0);
 });
 it('Factory admission revocation prevents all physical dispatches',async()=>{
   const f=await prepared();
   expect(await f.driver.runOnce({projectRoot:root,missionId:f.missionId,maxTasks:3,
      beforeDispatch:()=>false})).toMatchObject({
      status:'blocked',reason:'factory-admission-revoked',state:'running',performed:[],
   });
   expect(f.launched).toBe(0);
 });
 it('existing Factory-gated Native driver executes three dependent Mission tasks to terminal',async()=>{
   const f=await prepared();
   const gates:string[]=[];
   expect(await f.driver.runOnce({projectRoot:root,missionId:f.missionId,maxTasks:3,
     beforeDispatch:taskId=>{gates.push(taskId);return true;}})).toMatchObject({
     status:'completed',state:'completed',performed:['produce','evaluate','verify'],
   });
   expect(gates).toEqual(['produce','evaluate','verify']);
   expect(f.launched).toBe(3);
   expect(await f.driver.readMission({projectRoot:root,missionId:f.missionId}))
      .toMatchObject({state:'completed',revision:6,executionMode:'durable-executor'});
   expect(await f.driver.runOnce({projectRoot:root,missionId:f.missionId,maxTasks:3,
      beforeDispatch:()=>true})).toMatchObject({status:'blocked',reason:'untrusted-native-request'});
   expect(f.launched).toBe(3);
 });
});
