import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { ExecutionLeaseStore } from '../../src/missions/execution-lease.js';
import { ExecutionInvocationJournal } from '../../src/missions/execution-invocation-journal.js';
import { runNativeReadyCycle } from '../../src/missions/native-ready-cycle.js';
import type { NativeReadyCycleOptions } from '../../src/missions/native-ready-cycle.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-cycle-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');

async function fixture(override = plan()) {
  const runtime = new MissionService({ projectRoot: root, channel: 'internal',
    executionAdmission: (view, action) => {
      const r = root.replace(/\\/g, '/');
      return { action, worktree: { rooted: true, root:r, candidate:r, repositoryId: 'fixture',
          sourceStateId: sha('source') },
        policy: { allowed:true, decisionRef: 'policy:fixture' },
        budget: { allowed:true, reservationRef:'budget:fixture', estimatedMinor:view.budget!.estimatedMinor,
          remainingMinor:view.budget!.ceilingMinor-view.budget!.reservedMinor-view.budget!.settledMinor-view.budget!.unresolvedMinor },
        permissions: { granted:true, required:['fs.write'], explicit:['fs.write'], authorizationRef:'auth:fixture' },
        evidenceRefs:['worktree:fixture','policy:fixture','budget:fixture','permission:fixture'] };
    },
    authorizeRuntimeEvent: (_view,kind) => ({authorized:true,receiptRef:'review:verified',
      ...(kind==='evidence.recorded' ? {independentQa:true as const}: {}) }),
  });
  const created = await runtime.create({requestId:'create',objective:'MVP ready slice'});
  if (!created.ok) throw new Error(created.message);
  const missionId = created.data.missionId;
  const planned = await runtime.plan({requestId:'plan',missionId,expectedRevision:1,plan:override});
  if (!planned.ok) throw new Error(planned.message);
  const admitted = await runtime.requestAction({requestId:'admit',missionId,expectedRevision:2,action:'admit'});
  if (!admitted.ok) throw new Error(admitted.message);
  const calls:string[]=[];
  const reviewCalls:string[]=[];
  const options: NativeReadyCycleOptions = {
    projectRoot: root, missionId, runtime, executorId:'fixture-executor', cycleId:'slice-one', maxTasks:3,
    async dispatch(taskId, view) {
      calls.push(taskId);
      return { status:'observed', reason:'process-observed-independent-qa-required',
        invocationId:'inv-'+taskId, sourceDigest:sha('source'), settlement:'observation-required',
        receipt:{
          status:'completed',missionId,taskId,invocationId:'inv-'+taskId,
          threadId:'logical-'+taskId,physicalThreadId:'01a155b3-3e7a-7691-93ce-5301127c18c1',
          pid:100+iIndex(taskId),outcome:'completed',exitCode:0,events:[],stdout:'',stderr:'',
          settlement:'observation-required',
        } };
    },
    async review(taskId) {
      reviewCalls.push(taskId);
      return { accepted:true,artifactDigest:sha('artifact'),reviewerRunId:'qa-'+taskId,evidenceId:'proof-'+taskId };
    },
    async settle(taskId) {
      return calls.includes(taskId) && reviewCalls.includes(taskId);
    },
  };
  return { missionId, runtime, options, calls, reviewCalls,
    view:()=>new MissionStore(root).loadView(missionId)! };
}
function iIndex(v:string){return ['produce','evaluate','verify'].indexOf(v);}

describe('single native once/refill pass uses stock READY and terminal', () => {
  it('autonomously advances three dependent tasks and one verified terminal', async () => {
    const f = await fixture();
    expect(await runNativeReadyCycle(f.options)).toMatchObject({
      status:'completed',state:'completed',performed:['produce','evaluate','verify'],
    });
    expect(f.calls).toEqual(['produce','evaluate','verify']);
    expect(f.reviewCalls).toEqual(f.calls);
    expect(f.view()).toMatchObject({record:{state:'completed',revision:6},
      tasks:{produce:{status:'recorded-done'},evaluate:{status:'recorded-done'},verify:{status:'recorded-done'}}});
    expect(await runNativeReadyCycle({...f.options,cycleId:'no-repeat'}))
      .toMatchObject({status:'blocked',performed:[],state:'completed',reason:'not-running'});
    expect(f.calls).toHaveLength(3);
  });
  it('bounded one-task slices refill on a later call, reusing the same store', async () => {
    const f = await fixture();
    expect(await runNativeReadyCycle({...f.options,maxTasks:1,cycleId:'first'}))
      .toMatchObject({status:'partial',performed:['produce'],state:'running'});
    expect(await runNativeReadyCycle({...f.options,maxTasks:1,cycleId:'second'}))
      .toMatchObject({status:'partial',performed:['evaluate'],state:'running'});
    expect(await runNativeReadyCycle({...f.options,maxTasks:1,cycleId:'third'}))
      .toMatchObject({status:'completed',performed:['verify'],state:'completed'});
    expect(f.calls).toEqual(['produce','evaluate','verify']);
  });
  it('unknown/failed QA blocks affected frontier and refuses fabricated terminal', async () => {
    const f = await fixture();
    const original=f.options.review;
    const refusal:NativeReadyCycleOptions={...f.options,
      review:async (task,receipt,view) => task==='evaluate' ? null : original(task,receipt,view)};
    expect(await runNativeReadyCycle(refusal))
      .toMatchObject({status:'blocked',reason:'qa-not-verified',performed:['produce'],state:'running'});
    expect(f.calls).toEqual(['produce','evaluate']);
    expect(f.view()).toMatchObject({record:{state:'running'},
      tasks:{evaluate:{status:'unknown'}},unresolvedOperations:['task:evaluate']});
    expect(await runNativeReadyCycle({...f.options,cycleId:'resume'}))
      .toMatchObject({status:'partial',performed:[],state:'running'});
    expect(f.calls).toHaveLength(2);
  });
  it('restores a journal-confirmed task after crash before task observation, without redispatch', async () => {
    const f = await fixture();
    const lease = await new ExecutionLeaseStore(root).claim(f.missionId,'fixture-executor');
    const journal = new ExecutionInvocationJournal(root);
    let rejectDone = true;
    const runtime = {
      recordNativeEvent: async (raw: any) => {
        if (rejectDone && raw.type === 'task.observed' && raw.payload.taskId === 'produce'
            && raw.payload.status === 'recorded-done') {
          rejectDone = false;
          return { ok: false as const, code: 'admission-denied', message: 'test crash after durable outcome' };
        }
        return f.runtime.recordNativeEvent(raw);
      },
    };
    const durableSettle: typeof f.options.settle = async (taskId, receipt, qa) => {
      const view = f.view();
      const policyDigest = sha('fixture-policy');
      const intent = {
        missionId:f.missionId,taskId,invocationId:receipt.invocationId,
        planRevision:view.record.plan.revision,leaseGeneration:lease.generation,
        ownerId:lease.ownerId,sessionId:'fixture-session',policyRef:view.record.policyRef,
        policyDigest,sourceDigest:sha('fixture-source'),inputDigest:sha('fixture-input-'+taskId),
        authority:{decisionRef:'policy:fixture',policyDigest},
      };
      expect((await journal.prepare(intent)).status).toBe('prepared');
      expect((await journal.markDispatched(intent,'dispatch-'+taskId)).status).toBe('dispatched');
      expect((await journal.recordOutcome(intent,'succeeded',qa.artifactDigest,
        'authenticated-qa:'+taskId)).status).toBe('succeeded');
      return true;
    };
    expect(await runNativeReadyCycle({...f.options, runtime: runtime as any,
      settle:durableSettle, cycleId:'crashed'}))
      .toMatchObject({status:'blocked',reason:'native-task-or-independent-qa-refused',performed:[]});
    expect(f.calls).toEqual(['produce']);
    expect(f.view().tasks.produce.status).toBe('pending');
    const recovered: string[] = [];
    expect(await runNativeReadyCycle({...f.options,cycleId:'restart',settle:durableSettle,
      recoverSettled:async (taskId,view) => {
        if(taskId !== 'produce')return null;
        const entry=await journal.get(f.missionId,'inv-produce');
        if(entry?.status !== 'succeeded'||entry.missionId !== f.missionId ||
          entry.planRevision !== view.record.plan.revision ||
          entry.outcomeDigest !== sha('artifact') ||
          entry.receiptRef !== 'authenticated-qa:produce')return null;
        recovered.push(taskId);
        return {accepted:true,invocationId:entry.invocationId,
          artifactDigest:entry.outcomeDigest,reviewerRunId:'qa-produce',evidenceId:'proof-produce'};
      }})).toMatchObject({status:'completed',state:'completed',
      performed:['produce','evaluate','verify']});
    expect(recovered).toEqual(['produce']);
    expect(f.calls).toEqual(['produce','evaluate','verify']);
  });
  it('repairs missing QA evidence after a recorded-done task without repeating its process', async () => {
    const f = await fixture();
    expect(await runNativeReadyCycle({...f.options,maxTasks:1,cycleId:'first'}))
      .toMatchObject({status:'partial',performed:['produce']});
    let refuseEvidence = true;
    const runtime = {recordNativeEvent:async (raw:any) => {
      if (refuseEvidence && raw.type==='evidence.recorded') {
        refuseEvidence=false;
        return {ok:false as const,code:'admission-denied',message:'test crash before QA append'};
      }
      return f.runtime.recordNativeEvent(raw);
    }};
    expect(await runNativeReadyCycle({...f.options,maxTasks:1,cycleId:'second',runtime:runtime as any}))
      .toMatchObject({status:'blocked',reason:'native-task-or-independent-qa-refused'});
    expect(f.view().tasks.evaluate.status).toBe('recorded-done');
    expect(f.view().evidence).toHaveLength(0);
    expect(f.calls).toEqual(['produce','evaluate']);
    // No authenticated recovery reader: do not dispatch downstream work.
    expect(await runNativeReadyCycle({...f.options,cycleId:'no-evidence'}))
      .toMatchObject({status:'blocked',reason:'evidence-recovery-required'});
    expect(f.calls).toHaveLength(2);
    expect(await runNativeReadyCycle({...f.options,cycleId:'recover-evidence',recoverSettled:async taskId =>
      taskId === 'evaluate' ? {accepted:true,invocationId:'inv-evaluate',
        artifactDigest:sha('artifact'),reviewerRunId:'qa-evaluate',evidenceId:'proof-evaluate'} : null,
    })).toMatchObject({status:'completed',state:'completed',performed:['verify']});
    expect(f.calls).toEqual(['produce','evaluate','verify']);
    expect(f.view().evidence).toHaveLength(1);
  });
  it('selects complete current-plan QA digest instead of earlier partial evidence', async () => {
    const base = plan();
    const custom = plan({
      acceptance: [
        ...base.acceptance,
        {id:'security',check:'source review',inputs:[],producer:'metaharness',
          independent:true,mandatory:true},
      ],
      tasks: base.tasks.map(t => t.id === 'evaluate'
        ? {...t,acceptanceEvidence:['quality','security']} : t),
    });
    const f = await fixture(custom);
    let polluted = false;
    const runtime = {recordNativeEvent:async (raw:any) => {
      const outcome = await f.runtime.recordNativeEvent(raw);
      if (!polluted && outcome.ok && raw.type === 'task.observed'
          && raw.payload.taskId === 'evaluate' && raw.payload.status === 'recorded-done') {
        polluted = true;
        const stale = await f.runtime.recordNativeEvent({
          requestId:'prior-incomplete-quality', missionId:f.missionId,expectedRevision:4,
          type:'evidence.recorded',
          payload:{evidenceId:'prior-wrong-digest',criterionId:'quality',
            taskId:'evaluate',producer:'metaharness',
            artifactDigest:sha('partial-digest'),verified:true},
        });
        expect(stale).toMatchObject({ok:true});
      }
      return outcome;
    }};
    const res = await runNativeReadyCycle({...f.options,cycleId:'complete-set',
      runtime:runtime as any});
    expect(res).toMatchObject({status:'completed',state:'completed',
      performed:['produce','evaluate','verify']});
    expect(polluted).toBe(true);
    expect(f.view().evidence).toHaveLength(3);
    const correct = f.view().evidence.filter(e => e.artifactDigest === sha('artifact'));
    expect(correct.map(e => e.criterionId).sort()).toEqual(['quality','security']);
  });
  it('finishes a verifying Mission after crash before terminal without repeating Codex', async () => {
    const f = await fixture();
    let rejectTerminal = true;
    const runtime = { recordNativeEvent: async (raw: any) => {
      if (rejectTerminal && raw.type === 'acceptance.passed') {
        rejectTerminal = false;
        return {ok:false as const,code:'admission-denied',message:'test crash before terminal'};
      }
      return f.runtime.recordNativeEvent(raw);
    }};
    expect(await runNativeReadyCycle({...f.options,cycleId:'crashed-before-terminal',
      runtime:runtime as any})).toMatchObject({
      status:'blocked',reason:'native-terminal-refused',state:'verifying',
      performed:['produce','evaluate','verify']});
    expect(f.calls).toEqual(['produce','evaluate','verify']);
    // A restarted caller must not issue a second tasks.settled or dispatch.
    expect(await runNativeReadyCycle({...f.options,cycleId:'restart-verifying'}))
      .toMatchObject({status:'completed',state:'completed',performed:[]});
    expect(f.view().record.revision).toBe(6);
    expect(f.calls).toHaveLength(3);
  });
  it('rechecks Factory admission before EVERY dependent physical launch', async () => {
    const f = await fixture();
    let admitted = true;
    const checked: string[] = [];
    const result = await runNativeReadyCycle({
      ...f.options, cycleId:'factory-capacity-check',
      beforeDispatch: async taskId => {
        checked.push(taskId);
        if (taskId === 'evaluate') admitted = false; // Simulated 429 / project pause.
        return admitted;
      },
    });
    expect(result).toMatchObject({
      status:'blocked',reason:'factory-admission-revoked',state:'running',performed:['produce'],
    });
    expect(checked).toEqual(['produce','evaluate']);
    expect(f.calls).toEqual(['produce']); // No second executor was launched.
    expect(f.view().tasks.evaluate.status).toBe('pending');
  });
  it('rejects missing admission before the first worker and makes no terminal change', async () => {
    const f = await fixture();
    expect(await runNativeReadyCycle({...f.options,cycleId:'guardian-block',
      beforeDispatch: async () => false}))
      .toMatchObject({status:'blocked',reason:'factory-admission-revoked',performed:[],state:'running'});
    expect(f.calls).toEqual([]);
  });
  it('rejects invalid cycle bounds without process or state writes', async () => {
    const f = await fixture();
    await expect(runNativeReadyCycle({...f.options,maxTasks:0})).rejects.toThrow('maxTasks');
    expect(f.calls).toEqual([]);
  });
});
