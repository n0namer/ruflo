/**
 * Opt-in REAL gpt-6-luna E2E using stock Factory/CrewSync provider admission,
 * the original Native MissionStore/lease/journal and two physical Codex workers.
 * QA runs as separate deterministic functional test subprocesses; those are
 * NOT yet authenticated production reviewer-service credentials.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
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
import { createNativeM2FactoryDriver } from '../../src/missions/native-factory-driver.js';
import { pathToFileURL } from 'node:url';
import { setPolicyMode, upsertPolicyRule, loadPolicyState } from '../../src/services/policy-runtime.js';

const digest = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const codexBin = 'D:/npm-global/node_modules/@openai/codex/bin/codex.js';
const disabledMcp = ['ai-crew-sync-local','ruflo','node_repl','hostinger','hostinger-vps','coolify'];
const checker = fileURLToPath(new URL('./fixtures/independent-code-qa.mjs', import.meta.url));
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

describe('REAL Codex coding through bounded NativeReadyCycle', () => {
  it.runIf(process.env.RUFLO_ENABLE_FACTORY_LIVE_TWO_M2 === '1')('two REAL Codex code tasks refill automatically and pass independent QA', async () => {
    const store = new MissionStore(root);
    const leases = new ExecutionLeaseStore(root, { defaultTtlMs: 600_000 });
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
    const created = await client.create({ requestId: 'mission-create', objective: 'Real Codex independently tested sumFinite implementation' });
    if (!created.ok) throw Error(created.message);
    const missionId = created.data.missionId;
    const tasks = ['make','review'].map((id, index) => ({
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
      command: process.execPath, commandPrefixArgs: [codexBin], cwd: root, timeoutMs: 140_000,
      spawn: (command, args, options) => nodeSpawn(command, [
        args[0],
        ...disabledMcp.flatMap(name=>['-c','mcp_servers.'+name+'.enabled=false']),
        ...args.slice(1,-1), '-m', 'gpt-6-luna', '--sandbox', 'workspace-write',
        args.at(-1)!,
      ],options) as ReturnType<typeof nodeSpawn>,
    });
    const physicalPids: number[] = [];
    const qaPids: number[] = [];
    const intents = new Map<string, any>();
    let lastDispatch: { port: CodexMissionPort; input: Parameters<CodexMissionPort['dispatch']>[0] } | null = null;
    const viewNow = () => store.loadView(missionId)!;
    const readyNow = () => readyTaskIdsFromMission(viewNow());
    const residentPorts = {
      projectRoot:root,runtime,executorId:'test-native-owner',
      cycleId:'factory-owned-live-two-code',
      async dispatch(taskId,view) {
        const invocationId = 'inv-' + taskId;
        const prompt = [
          'In this isolated Git repository, write exactly one JavaScript ES module:',
          '.claude-flow/probe-artifacts/' + taskId + '.mjs',
          'Export exactly the named function ' + (taskId === 'make' ? 'sumFinite(a,b)' : 'multiplyFinite(a,b)') + '.',
          'If either argument is not typeof number, throw TypeError.',
          'If either argument is not Number.isFinite, throw RangeError.',
          'Return the ' + (taskId === 'make' ? 'sum' : 'product') + ' of the arguments.',
          'Do not change any other file, and do not use MCP.',
          'Reply OK when complete.',
        ].join('\n');
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
          scope:{root:rootPath,resource:rootPath+'/.claude-flow/probe-artifacts/'+taskId+'.mjs'},
          fence:{missionId,leaseId:lease!.leaseId,
            generation:lease!.generation,revision:view.record.plan.revision},
        };
        const port = new CodexMissionPort({
          dispatch:{executor,leaseStore:leases,verifier:{
            verifyCredential:credential=>credential.authorizationRef===viewNow().record.authorizationRef,
            verifyInvocation:invocation=>readyNow().includes(invocation.taskId) &&
              invocation.missionEpoch===viewNow().lease.epoch,
            verifyPhysicalReceipt:result=>result.pid!==null&&result.pid>0&&
              readFileSync(join(root,'.claude-flow','probe-artifacts',taskId+'.mjs'),'utf8')
                .includes(taskId === 'make' ? 'sumFinite' : 'multiplyFinite'),
            readMissionEpoch:()=>viewNow().lease.epoch,
          }},
          journal,readEffect:()=>effect,readSourceDigest:()=>digest(git('rev-parse','HEAD')),
        });
        lastDispatch={port,input:{dispatch,intent,effect}};
        const observation=await port.dispatch(lastDispatch.input);
        console.log('LIVE_CODE_EXECUTOR='+JSON.stringify({taskId,observation:observation.status,
          processStatus:observation.receipt?.status,pid:observation.receipt?.pid,
          thread:observation.receipt?.physicalThreadId,exitCode:observation.receipt?.exitCode}));
        if(observation.receipt?.pid) physicalPids.push(observation.receipt.pid);
        return observation;
      },
      async review(taskId,receipt) {
        const artifact=join(root,'.claude-flow','probe-artifacts',taskId+'.mjs');
        const proof=JSON.parse(execFileSync(process.execPath,[checker,artifact,taskId],
          {cwd:root,encoding:'utf8',windowsHide:true,timeout:5000}).trim());
        if(proof.kind!=='independent-process-check'||proof.verdict!=='passed'||proof.pid===receipt.pid)
          return null;
        console.log('LIVE_CODE_QA='+JSON.stringify({taskId,qaPid:proof.pid,
          artifactDigest:proof.artifactDigest,tests:proof.tests}));
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
    };
    const branch = process.env.RUFLO_M2_FACTORY_CHECKOUT;
    if (!branch) throw Error('trusted Factory worktree is required');
    const factory = await import(/* @vite-ignore */
      pathToFileURL(join(branch,'lib','factory-autopilot-service.mjs')).href);
    const nativeDriver=createNativeM2FactoryDriver(residentPorts);
    const cycle=await factory.runCanonicalProdServiceCycle({
      factoryRoot:'D:/Users/NIKITA/Documents/DEV/ruflo',
      project:'ruflo',projectPath:root,profile:{root},
      nativeMissionId:missionId,nativeMissionRuntime:nativeDriver,nativeMaxTasks:2,
    });
    console.log('LIVE_CODE_M2_RESULT='+JSON.stringify({missionId,
      status:cycle.status,performed:cycle.performed,state:cycle.state,workerPids:physicalPids,
      reviewerPids:qaPids}));
    expect(cycle).toMatchObject({status:'NATIVE_MISSION_TERMINAL_READBACK',nativeState:'completed',performed:['make','review'],serverDone:false});
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
  }, 360_000);
});
