import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { runNativeReadyCycle } from '../../src/missions/native-ready-cycle.js';
import type { NativeReadyCycleOptions } from '../../src/missions/native-ready-cycle.js';
import { plan } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ruflo-cycle-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');

async function fixture() {
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
  const planned = await runtime.plan({requestId:'plan',missionId,expectedRevision:1,plan:plan()});
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
  it('rejects invalid cycle bounds without process or state writes', async () => {
    const f = await fixture();
    await expect(runNativeReadyCycle({...f.options,maxTasks:0})).rejects.toThrow('maxTasks');
    expect(f.calls).toEqual([]);
  });
});
