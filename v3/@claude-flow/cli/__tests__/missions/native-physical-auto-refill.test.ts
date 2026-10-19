/**
 * Physical two-process executor + external QA fixture over genuine Ruflo
 * MissionStore, policy ledger, lease, invocation journal, M2 port and terminal.
 * NOT a real AI-provider E2E. The worker is a deterministic Node subprocess
 * emitting the stock Codex JSONL schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionService } from '../../src/missions/service.js';
import { MissionStore } from '../../src/missions/store.js';
import { createNativePolicyHost } from '../../src/missions/native-policy-admission.js';
import { installNativeMissionHost, nativeMissionRuntimeService, nativeMissionService } from '../../src/missions/native-runtime-host.js';
import { ExecutionLeaseStore, type ExecutionLease } from '../../src/missions/execution-lease.js';
import { ExecutionInvocationJournal } from '../../src/missions/execution-invocation-journal.js';
import { CodexMissionPort, codexPortInputDigest } from '../../src/missions/execution-m2-r7-codex-port.js';
import { CodexExecutor } from '../../src/missions/codex-executor.js';
import { readyTaskIdsFromMission } from '../../src/missions/execution-frontier.js';
import { runNativeReadyCycle } from '../../src/missions/native-ready-cycle.js';
import { setPolicyMode, upsertPolicyRule, loadPolicyState } from '../../src/services/policy-runtime.js';

const digest = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const worker = fileURLToPath(new URL('./fixtures/fake-codex-jsonl.mjs', import.meta.url));
const checker = fileURLToPath(new URL('./fixtures/independent-qa-probe.mjs', import.meta.url));
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 7000, windowsHide: true, stdio: ['ignore','pipe','ignore'],
}).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ruflo-physical-m2-'));
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.claude-flow/\n', 'utf8');
  git('add', '.gitignore');
  git('-c', 'user.name=Ruflo Fixture', '-c','user.email=qa@example.com','commit','-q','-m','root');
});
afterEach(() => {
  installNativeMissionHost(null);
  rmSync(root, { recursive: true, force: true });
});

describe('PHYSICAL autonomous refill through NativeReadyCycle; model is a fixture', () => {
  it('self-refills two physical process tasks with independent QA and Native terminal', async () => {
    const store = new MissionStore(root);
    const leases = new ExecutionLeaseStore(root, { defaultTtlMs: 120_000 });
    const journal = new ExecutionInvocationJournal(root);
    let lease: ExecutionLease | null = null;
    const outcomes = new Map<string, { invocationId: string; digest: string; qaPid: number; workerPid: number }>();
    const available = () => true;

    await setPolicyMode('enforce', root);
    await upsertPolicyRule({ id: 'fixture-executor-only', effect: 'allow',
      actions: ['mission.execute', 'mission.capability.fs.write'] }, root);
    const policy = createNativePolicyHost(root, { durableExecutorReady: available });
    installNativeMissionHost({
      ...policy,
      async authorizeRuntimeEvent(view, type, payload) {
        if (!lease || view.record.authorizationRef === undefined) return null;
        try { leases.assertCurrentWithinMission(view, lease); } catch { return null; }
        if (type === 'task.observed' && payload.status === 'recorded-done') {
          const task = outcomes.get(String(payload.taskId));
          if (!task || task.invocationId !== payload.invocationId) return null;
        }
        if (type === 'evidence.recorded') {
          const qa = outcomes.get('review');
          if (!qa || qa.digest !== payload.artifactDigest || payload.verified !== true) return null;
          return { authorized: true as const, receiptRef: 'qa-process:' + qa.qaPid, independentQa: true as const };
        }
        if (type === 'acceptance.passed' && !outcomes.has('review')) return null;
        return { authorized: true as const, receiptRef: 'fixture-native-verified:' + view.record.missionId };
      },
    });
    const client = nativeMissionService(root, 'cli');
    const created = await client.create({ requestId: 'mission-create', objective: 'Two checked physical fixture tasks' });
    if (!created.ok) throw Error(created.message);
    const missionId = created.data.missionId;
    const tasks = ['make', 'review'].map((id, index) => ({
      id, title: 'Fixture ' + id, dependsOn: index ? ['make'] : [],
      executor: { mode: 'durable-executor' as const, requirement: 'codex' },
      capabilityCeiling: ['fs.write'], estimatedCostMinor: 10,
      acceptanceEvidence: index ? ['quality'] : [],
    }));
    const plan = {
      tasks, acceptance: [{ id: 'quality', check: 'independent artifact verification',
        inputs: [], producer: 'independent-reviewer', independent: true, mandatory: true }],
      budget: { currency: 'USD', ceilingMinor: 100 }, scope: { capabilities: ['fs.write'] },
    };
    const planned = await client.plan({ requestId: 'mission-plan', missionId,
      expectedRevision: 1, plan });
    if (!planned.ok) throw Error(planned.message);
    const admitted = await client.requestAction({ requestId: 'mission-admit', missionId,
      expectedRevision: 2, action: 'admit' });
    expect(admitted).toMatchObject({ ok: true, data: { state: 'queued', revision: 3 } });
    expect(loadPolicyState(root).receipts.length).toBeGreaterThanOrEqual(2);
    lease = await leases.claim(missionId, 'test-native-owner');
    expect(lease.generation).toBe('1');
    const runtime = nativeMissionRuntimeService(root);
    const rootPath = root.replace(/\\/g, '/');
    const sourceDigest = digest(git('rev-parse', 'HEAD'));
    const policyDigest = digest('fixture-enforced-policy');
    const executor = new CodexExecutor({
      command: process.execPath, commandPrefixArgs: [worker], cwd: root, timeoutMs: 5_000,
    });
    const physicalPids: number[] = [];
    const qaPids: number[] = [];
    const intents = new Map<string, any>();
    let lastDispatch: { port: CodexMissionPort; input: Parameters<CodexMissionPort['dispatch']>[0] } | null = null;
    const viewNow = () => store.loadView(missionId)!;
    const readyNow = () => readyTaskIdsFromMission(viewNow());
    const cycle = await runNativeReadyCycle({
      projectRoot:root,missionId,runtime,executorId:'test-native-owner',
      cycleId:'physical-refill',maxTasks:2,
      async dispatch(taskId,view) {
        const invocationId = 'inv-' + taskId;
        const prompt = JSON.stringify({taskId, objective:'Physical bounded process fixture'});
        const threadId = 'logical-' + taskId;
        const dispatch = {
          prompt,
          invocation: {missionId,taskId,invocationId,threadId,
            missionEpoch:view.lease.epoch,planDigest:view.record.plan.digest},
          credential: {missionId,taskId,invocationId,threadId,
            ownerId:'test-native-owner',sessionId:'test-native-session',
            authorizationRef:view.record.authorizationRef!,planDigest:view.record.plan.digest,
            credential:'trusted-in-process-test-fixture'},
          lease:lease!,
        };
        const intent = {
          missionId,taskId,invocationId,planRevision:view.record.plan.revision,
          leaseGeneration:lease!.generation,ownerId:'test-native-owner',
          sessionId:'test-native-session',policyRef:view.record.policyRef,
          policyDigest,sourceDigest,inputDigest:codexPortInputDigest(dispatch),
          authority:{decisionRef:view.record.authorizationRef!,policyDigest},
        };
        intents.set(taskId,intent);
        const effect = {
          effectId:invocationId, permission:{granted:true,authenticated:true,capability:'codex.execute',
            authorizationRef:view.record.authorizationRef!},
          scope:{root:rootPath,resource:rootPath+'/.claude-flow/probe-artifacts/'+taskId+'.txt'},
          fence:{missionId,leaseId:lease!.leaseId,
            generation:lease!.generation,revision:view.record.plan.revision},
        };
        const port = new CodexMissionPort({
          dispatch:{executor,leaseStore:leases,verifier:{
            verifyCredential:credential=>credential.authorizationRef===viewNow().record.authorizationRef,
            verifyInvocation:invocation=>readyNow().includes(invocation.taskId) &&
              invocation.missionEpoch===viewNow().lease.epoch,
            verifyPhysicalReceipt:result=>result.pid!==null&&result.pid>0&&
              readFileSync(join(root,'.claude-flow','probe-artifacts',taskId+'.txt'),'utf8')===
                'M2:'+taskId+':verified',
            readMissionEpoch:()=>viewNow().lease.epoch,
          }},
          journal,readEffect:()=>effect,readSourceDigest:()=>digest(git('rev-parse','HEAD')),
        });
        lastDispatch={port,input:{dispatch,intent,effect}};
        const observation=await port.dispatch(lastDispatch.input);
        if(observation.receipt?.pid) physicalPids.push(observation.receipt.pid);
        return observation;
      },
      async review(taskId,receipt) {
        const artifact=join(root,'.claude-flow','probe-artifacts',taskId+'.txt');
        const proof=JSON.parse(execFileSync(process.execPath,[checker,artifact,taskId],
          {cwd:root,encoding:'utf8',windowsHide:true,timeout:5000}).trim());
        if(proof.kind!=='independent-process-check'||proof.verdict!=='passed'||proof.pid===receipt.pid)
          return null;
        qaPids.push(proof.pid);
        outcomes.set(taskId,{invocationId:receipt.invocationId,digest:proof.artifactDigest,
          qaPid:proof.pid,workerPid:receipt.pid!});
        return {accepted:true,artifactDigest:proof.artifactDigest,
          evidenceId:'qa-'+taskId,reviewerRunId:'review:'+proof.pid};
      },
      async settle(taskId,receipt,qa) {
        const intent=intents.get(taskId);
        if(!intent||!outcomes.has(taskId))return false;
        const committed=await journal.recordOutcome(intent,'succeeded',qa.artifactDigest,
          'qa-process:'+outcomes.get(taskId)!.qaPid);
        return committed.status==='succeeded';
      },
    });
    expect(cycle).toMatchObject({status:'completed',state:'completed',performed:['make','review']});
    expect(new Set(physicalPids).size).toBe(2);
    expect(qaPids.every(pid => !physicalPids.includes(pid))).toBe(true);
    expect(readyNow()).toEqual([]);
    // Restart/replay with the identical invocation must never start a third worker.
    expect(lastDispatch).not.toBeNull();
    expect(await lastDispatch!.port.dispatch(lastDispatch!.input)).toMatchObject({
      status: 'unknown', reason: 'reconciliation-required',
    });
    expect(physicalPids).toHaveLength(2);
    const recovered = new MissionStore(root).loadView(missionId);
    expect(recovered).toMatchObject({ record: { state: 'completed', revision: 6 } });
    expect(readyTaskIdsFromMission(recovered!)).toEqual([]);
    expect(await runtime.recordNativeEvent({ requestId: 'late', missionId,
      expectedRevision: 6, type: 'task.observed',
      payload: { taskId: 'review', status:'recorded-done', leaseEpoch: 1 } }))
      .toMatchObject({ ok: false, code: 'terminal' });
  }, 25_000);
});
