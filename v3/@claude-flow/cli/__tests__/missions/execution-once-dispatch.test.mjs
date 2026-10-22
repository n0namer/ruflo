import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dispatchOnce} from '../../src/missions/execution-once-dispatch.ts';

const digest=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
const prompt='inspect the authorized code, do not write or send';
const missionId='msn_aaaaaaaaaaaaaaaaaaaaaaaa';
function fixture() {
  const intent={
    missionId,taskId:'inspect',invocationId:'inv-a',planRevision:1,
    leaseGeneration:'4',ownerId:'owner',sessionId:'sess',
    policyRef:'policy:1',policyDigest:digest('policy'),sourceDigest:digest('source'),
    inputDigest:digest(prompt),authority:{decisionRef:'policy-allow',policyDigest:digest('policy')}
  };
  const request={
    prompt,invocation:{missionId,taskId:'inspect',invocationId:'inv-a',threadId:'thread',
      missionEpoch:4,planDigest:digest('plan')},
    credential:{missionId,taskId:'inspect',invocationId:'inv-a',
      ownerId:'owner',sessionId:'sess',threadId:'thread',
      authorizationRef:'auth',planDigest:digest('plan'),credential:'proof'},
    lease:{missionId,ownerId:'owner',generation:'4',leaseId:'lease',acquiredAt:'now',expiresAt:'later'}
  };
  return {intent,request};
}
function mock({dispatchFails=false,prepareFails=false,markFails=false}={}) {
 let state=null, runs=0, marks=0, prepares=0;
 const journal={
   async prepare(intent) {prepares++;if(prepareFails)throw Error('invalid lease');return state??{...intent,status:'prepared',preparedAt:'now'};},
   async markDispatched(intent,ref) {marks++;if(markFails)throw Error('commit outcome unknown');
     if(!state)state={...intent,status:'dispatched',preparedAt:'now',dispatchRef:ref,dispatchedAt:'now'};
     return state;
   }
 };
 const binding={async dispatch(_request){runs++;if(dispatchFails)throw Error('transport unknown');
   return {status:'completed',settlement:'observation-required',events:[],outcome:'completed'};
 }};
 return {journal,binding,get runs(){return runs},get marks(){return marks},get prepares(){return prepares}};
}
const execute=(opts,changes={})=>dispatchOnce({...fixture(),...opts,...changes});

test('one physical dispatch; replay stays blocked even after an observed result',async()=>{
 const m=mock(),f=fixture();const first=await dispatchOnce({...f,...m});
 assert.equal(first.kind,'observed');
 assert.match(first.dispatchRef,/^dispatch-[0-9a-f-]+$/);
 const repeated=await dispatchOnce({...f,...m});
 assert.deepEqual(repeated,{kind:'blocked',reason:'previously-dispatched'});
 assert.equal(m.runs,1);
});

test('parallel duplicates reserve one journal dispatch and one physical executor call',async()=>{
 const m=mock(),f=fixture();
 const outcomes=await Promise.all(Array.from({length:24},()=>dispatchOnce({...f,...m})));
 assert.equal(outcomes.filter(o=>o.kind==='observed').length,1);
 assert.equal(outcomes.filter(o=>o.kind==='blocked').length,23);
 assert.equal(m.runs,1);
 assert.ok(m.marks>=1);
});

test('mismatched prompt, mission, owner, session, lease epoch, task or thread fail before journal',async()=>{
 const cases=[
 f=>{f.request.prompt='forged prompt'},
 f=>{f.request.invocation.missionId='msn_other'},
 f=>{f.request.credential.ownerId='other'},
 f=>{f.request.credential.sessionId='other'},
 f=>{f.request.lease.generation='5'},
 f=>{f.request.invocation.missionEpoch=Number.MAX_SAFE_INTEGER+1},
 f=>{f.request.invocation.taskId='different'},
 f=>{f.request.credential.threadId='forged'}
 ];
 for(const change of cases) {
  const f=fixture(),m=mock();change(f);
  assert.deepEqual(await dispatchOnce({...f,...m}),{kind:'blocked',reason:'binding-mismatch'});
  assert.equal(m.prepares,0);assert.equal(m.marks,0);assert.equal(m.runs,0);
 }
});

test('failed lease/policy journal preparation prevents physical dispatch',async()=>{
 const m=mock({prepareFails:true});
 assert.deepEqual(await dispatchOnce({...fixture(),...m}),{kind:'blocked',reason:'journal-refused'});
 assert.equal(m.runs,0);
});

test('uncertain journal mark is unresolved and never runs executor',async()=>{
 const m=mock({markFails:true});
 assert.deepEqual(await dispatchOnce({...fixture(),...m}),{kind:'unresolved',reason:'journal-unknown'});
 assert.equal(m.runs,0);
});

test('unknown physical outcome retains durable dispatch marker; no retry',async()=>{
 const m=mock({dispatchFails:true}),f=fixture();
 const first=await dispatchOnce({...f,...m});
 assert.equal(first.kind,'unresolved');
 assert.equal(first.reason,'dispatch-unknown');
 assert.ok(first.dispatchRef);
 const repeat=await dispatchOnce({...f,...m});
 assert.deepEqual(repeat,{kind:'blocked',reason:'previously-dispatched'});
 assert.equal(m.runs,1);
});

test('a rejected executor receipt remains an observation and is never self-accepted',async()=>{
 const m=mock();
 m.binding.dispatch=async()=>({status:'rejected',reason:'stale-admission',settlement:'observation-required'});
 const result=await dispatchOnce({...fixture(),...m});
 assert.equal(result.kind,'observed');
 assert.equal(result.receipt.status,'rejected');
 assert.equal(result.receipt.settlement,'observation-required');
});

test('two different, independently bound invocation IDs may dispatch once each',async()=>{
 const m=mock(),one=fixture();
 const first=await dispatchOnce({...one,...m});
 assert.equal(first.kind,'observed');
 // A distinct journal must keep a distinct invocation; the once-boundary
 // does not synthesize a shared queue or compare unrelated missions.
 const other=mock(),two=fixture();
 two.intent.invocationId='inv-b';
 two.request.invocation.invocationId='inv-b';
 two.request.credential.invocationId='inv-b';
 const second=await dispatchOnce({...two,...other});
 assert.equal(second.kind,'observed');
 assert.equal(m.runs+other.runs,2);
});
