/**
 * Minimal request/response transport for an independently protected QA service.
 * Does not mint a reviewer key or treat the worker's QA claim as evidence.
 */
import { existsSync, lstatSync, linkSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExternalPinnedNativeQaReview } from './native-qa-external-readback.js';
import type { PinnedQaVerifierOptions } from './native-qa-attestation.js';
import type { IndependentQaAuthorityPorts } from './native-qa-authority.js';
import type { CodexDispatchReceipt } from './execution-dispatch-binding.js';
import type { MissionView } from './transitions.js';
import type { VerifiedTaskResult } from './native-ready-cycle.js';
import { createNativeM2FactoryDriver } from './native-factory-driver.js';
import type { ExternalQaResidentPorts } from './native-qa-external-readback.js';

const MISSION=/^msn_[a-f0-9]{24}$/;
const INV=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const wait=(milliseconds: number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const canonical=(x:string)=>realpathSync(resolve(x)).replaceAll('\\','/').toLowerCase();
const isUnder=(base:string,child:string)=>{
  const diff=relative(base,child);
  return diff===''||(!diff.startsWith('..'+sep)&&diff!=='..'&&!isAbsolute(diff));
};

export interface RequestedQaOptions {
  readonly inboxRoot: string;
  readonly spoolRoot: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}
export function createRequestedPinnedNativeQaReview(
  ports: Omit<IndependentQaAuthorityPorts,'readReviewer'|'authenticateReviewer'>,
  trust: PinnedQaVerifierOptions,
  options: RequestedQaOptions,
): (taskId:string,dispatch:CodexDispatchReceipt,view:MissionView)=>Promise<VerifiedTaskResult|null>{
  if(!ports?.projectRoot || !options?.inboxRoot || !options?.spoolRoot)throw new TypeError('QA transport roots required');
  const project=canonical(ports.projectRoot);
  const inbox=canonical(options.inboxRoot);
  const spool=canonical(options.spoolRoot);
  if(isUnder(project,inbox)||isUnder(inbox,project)||isUnder(project,spool)||isUnder(spool,project)||
     inbox===spool)throw new TypeError('QA transport cannot overlap worker workspace');
  const timeout=options.timeoutMs??90000,poll=options.pollMs??500;
  if(!Number.isSafeInteger(timeout)||timeout<500||timeout>300000||
     !Number.isSafeInteger(poll)||poll<25||poll>5000)throw new RangeError('QA poll bounded');
  const validateReceipt=createExternalPinnedNativeQaReview(ports,spool,trust);
  return async(taskId,dispatch,view)=>{
    if(!MISSION.test(dispatch?.missionId??'')||!INV.test(dispatch?.invocationId??'')||
       !/^[a-z][a-z0-9-]{0,63}$/.test(taskId)||dispatch.taskId!==taskId||
       dispatch.status!=='completed'||dispatch.exitCode!==0||
       !view?.record||view.record.missionId!==dispatch.missionId||
       view.record.state!=='running')return null;
    const request={
      missionId:dispatch.missionId,invocationId:dispatch.invocationId,taskId,
      workspaceRoot:ports.projectRoot,
      planRevision:view.record.plan.revision,
      criteriaDigest:view.record.acceptance.criteriaDigest,
    };
    const name=dispatch.missionId+'--'+dispatch.invocationId+'.request.json';
    const target=join(inbox,name);
    // Once written, a request cannot be replaced to change the source/plan.
    try{
      const bytes=JSON.stringify(request)+'\n';
      if(existsSync(target)){
        if(lstatSync(target).isSymbolicLink()||readFileSync(target,'utf8')!==bytes)return null;
      }else{
        const tmp=join(inbox,'.'+name+'.'+randomUUID()+'.tmp');
        try{
          writeFileSync(tmp,bytes,{flag:'wx'});
          // Atomic publication without replacing a concurrently created request.
          linkSync(tmp,target);
        }finally{
          try{ if(existsSync(tmp))unlinkSync(tmp) }catch{}
        }
      }
    }catch{return null}
    const deadline=Date.now()+timeout;
    do{
      const accepted=await validateReceipt(taskId,dispatch,view);
      if(accepted)return accepted;
      if(Date.now()>=deadline)return null;
      await wait(Math.min(poll,deadline-Date.now()));
    }while(true);
  };
}


/** Signed QA-requesting factory driver; worker cannot supply reviewer authority. */
export function createRequestedQaFactoryDriver(
  ports: ExternalQaResidentPorts,
  trust: PinnedQaVerifierOptions,
  options: RequestedQaOptions,
) {
  if(!ports || ports.executorId!==ports.qa?.workerPrincipalId){
    throw new TypeError('factory QA worker owner mismatch');
  }
  const {qa,...driverPorts}=ports;
  const review=createRequestedPinnedNativeQaReview({
    ...qa,projectRoot:ports.projectRoot,
  },trust,options);
  return createNativeM2FactoryDriver({...driverPorts,review});
}
