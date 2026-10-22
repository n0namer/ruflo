import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

const missions = new URL('../../src/missions/', import.meta.url);
const validation = new URL('../../../../docs/validation/', import.meta.url);
const aliases = new Map(['execution-dispatch-binding', 'execution-effect-guard'].map((name) => [
  new URL(`${name}.js`, missions).href, new URL(`${name}.ts`, missions).href,
]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = new URL(specifier, context.parentURL ?? import.meta.url).href;
    return aliases.has(target) ? { url: aliases.get(target), shortCircuit: true } : nextResolve(specifier, context);
  },
});
const { CodexMissionPort, codexPortInputDigest } = await import(new URL('execution-m2-r7-codex-port.ts', missions));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => `sha256:${sha(value)}`;
const producerKey = 'ruflo-upstream-dev:m2-r7c:codex-binding:goal';
const producerAttempt = 'attempt-b6a92fda-7255-4b97-a098-5c12f2e27e31';
const report = JSON.parse(readFileSync(new URL('m2-r7-codex-binding-result.json', validation), 'utf8'));
const receipts = JSON.parse(readFileSync(new URL('m2-r8-producer-receipts.json', validation), 'utf8'));

function validateProducer(candidate, record) {
  assert.equal(candidate.task_key, producerKey);
  assert.equal(candidate.project, 'ruflo-upstream-dev');
  assert.equal(candidate.attempt_id, producerAttempt);
  assert.equal(candidate.session_id, 'manual-20261015-ruflo-upstream-native-m2-hyper20-r7c-goal');
  assert.equal(candidate.outcome, 'CANDIDATE');
  assert.deepEqual(candidate.acceptance, { level: 'UNACCEPTED' });
  assert.deepEqual(candidate.producer, { thread_id: null, role: 'implementer' });
  assert.equal(record.key, producerKey);
  assert.equal(record.source_attempt, producerAttempt);
  assert.equal(record.producer_thread, '01a13f31-1d9d-7fe1-be54-10ea62504df8');
  assert.equal(record.published_note.scope, 'go-core.worker-result.v1');
  assert.equal(record.published_note.key, `${producerKey}:attempt:${producerAttempt}`);
  assert.equal(record.transport, 'VERIFIED_NOT_ACCEPTED');
  assert.equal(record.note_status, true);
  const expectedPaths = [
    'v3/@claude-flow/cli/src/missions/execution-m2-r7-codex-port.ts',
    'v3/@claude-flow/cli/__tests__/missions/m2-r7-codex-port.test.mjs',
    'v3/docs/validation/m2-r7-codex-binding-result.json',
  ].sort();
  assert.deepEqual(record.artifacts.map(({ path }) => path).sort(), expectedPaths);
  assert.deepEqual([...candidate.changed_files].sort(), expectedPaths);
  for (const artifact of record.artifacts) {
    const allowed = new Map([
      ['v3/@claude-flow/cli/src/missions/execution-m2-r7-codex-port.ts', new URL('execution-m2-r7-codex-port.ts', missions)],
      ['v3/@claude-flow/cli/__tests__/missions/m2-r7-codex-port.test.mjs', new URL('m2-r7-codex-port.test.mjs', import.meta.url)],
      ['v3/docs/validation/m2-r7-codex-binding-result.json', new URL('m2-r7-codex-binding-result.json', validation)],
    ]);
    assert.ok(allowed.has(artifact.path));
    assert.equal(sha(readFileSync(allowed.get(artifact.path))), artifact.sha256);
  }
}
const record = receipts.records.find((entry) => entry.key === producerKey);

test('producer binding and all three fresh artifact digests match the receipt snapshot, not live server authority', () => {
  assert.equal(receipts.project, 'ruflo-upstream-dev');
  assert.equal(receipts.status, 'UNACCEPTED');
  validateProducer(report, record);
});
for (const [name, change] of [
  ['wrong project', (candidate) => { candidate.project = 'foreign'; }],
  ['wrong Mission task', (candidate) => { candidate.task_key = 'foreign'; }],
  ['false GREEN', (candidate) => { candidate.acceptance.level = 'ACCEPTED_GREEN'; }],
  ['unknown report outcome', (candidate) => { candidate.outcome = 'UNKNOWN'; }],
  ['stale artifact SHA', (_, receipt) => { receipt.artifacts[0].sha256 = '0'.repeat(64); }],
  ['wrong producer thread', (_, receipt) => { receipt.producer_thread = 'foreign'; }],
  ['missing transport note', (_, receipt) => { receipt.published_note.key = ''; }],
  ['duplicate artifact substitution', (_, receipt) => { receipt.artifacts[1] = structuredClone(receipt.artifacts[0]); }],
]) {
  test(`receipt boundary rejects ${name}`, () => {
    const candidate = structuredClone(report);
    const receipt = structuredClone(record);
    change(candidate, receipt);
    assert.throws(() => validateProducer(candidate, receipt));
  });
}

function harness() {
  const dispatch = {
    prompt: 'Independent reviewer fixture; never execute a physical process.',
    invocation: { missionId: 'qa-mission', taskId: 'qa-task', invocationId: 'qa-invocation', threadId: 'qa-thread', missionEpoch: 2, planDigest: digest('plan') },
    credential: { missionId: 'qa-mission', taskId: 'qa-task', invocationId: 'qa-invocation', threadId: 'qa-thread', ownerId: 'qa-owner', sessionId: 'qa-session', authorizationRef: 'qa-decision', planDigest: digest('plan'), credential: 'fixture-only' },
    lease: { missionId: 'qa-mission', ownerId: 'qa-owner', generation: '2' },
  };
  const intent = {
    missionId: 'qa-mission', taskId: 'qa-task', invocationId: 'qa-invocation', ownerId: 'qa-owner', sessionId: 'qa-session',
    planRevision: 1, leaseGeneration: '2', policyRef: 'qa-policy', policyDigest: digest('policy'), sourceDigest: digest('source'),
    inputDigest: codexPortInputDigest(dispatch), authority: { decisionRef: 'qa-decision', policyDigest: digest('policy') },
  };
  const effect = {
    effectId: 'qa-invocation', permission: { granted: true, authenticated: true, capability: 'codex.execute', authorizationRef: 'qa-decision' },
    scope: { root: '/qa', resource: '/qa/task' }, fence: { missionId: 'qa-mission', leaseId: 'qa-lease', generation: '2', revision: 1 },
  };
  const request = { dispatch, intent, effect };
  const state = { calls: 0, prepares: 0, receipt: null, leaseValid: true, source: intent.sourceDigest, provenance: true, physicalChecks: 0, mutate: null };
  const options = {
    dispatch: {
      executor: { async run(execution) {
        state.calls += 1;
        const result = {
          outcome: 'completed', pid: 6789, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1,
          admission: structuredClone(execution.admission), terminationConfirmed: true, settlement: 'observation-required', invalidJsonlLines: [],
          events: [
            { value: { type: 'thread.started', thread_id: 'qa-thread' }, raw: '', line: 1 },
            { value: { type: 'dispatch.receipt', status: 'completed', missionId: 'qa-mission', taskId: 'qa-task', invocationId: 'qa-invocation', threadId: 'qa-thread', pid: 6789, sourceDigest: intent.sourceDigest }, raw: '', line: 2 },
          ],
        };
        state.mutate?.(result);
        return result;
      } },
      verifier: {
        verifyCredential: async () => true, verifyInvocation: async () => true, readMissionEpoch: async () => 2,
        verifyPhysicalReceipt: async () => { state.physicalChecks += 1; return state.provenance; },
      },
      leaseStore: { async assertCurrent() { if (!state.leaseValid) throw new Error('lease expired'); } },
    },
    journal: {
      async prepare(value) {
        state.prepares += 1;
        state.receipt ??= { ...structuredClone(value), status: 'prepared', preparedAt: '2026-10-15T00:00:00.000Z' };
        return structuredClone(state.receipt);
      },
      async markDispatched(value, dispatchRef) {
        if (state.receipt.status === 'prepared') state.receipt = { ...state.receipt, status: 'dispatched', dispatchRef, dispatchedAt: '2026-10-15T00:00:01.000Z' };
        return structuredClone(state.receipt);
      },
    },
    readSourceDigest: async () => state.source,
    readEffect: async () => structuredClone(effect),
  };
  return { request, state, options, port: new CodexMissionPort(options) };
}
function noTerminal(value) {
  assert.equal(value.settlement, 'observation-required');
  assert.equal(value.acceptance, undefined);
  assert.ok(['observed', 'unknown', 'rejected'].includes(value.status));
}

test('valid independent fixture observes once and cannot replay; never settles journal', async () => {
  const fixture = harness();
  const result = await fixture.port.dispatch(fixture.request);
  assert.equal(result.status, 'observed');
  noTerminal(result);
  assert.equal(fixture.state.receipt.status, 'dispatched');
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'unknown');
  assert.equal(fixture.state.calls, 1);
});
for (const [name, change] of [
  ['exit-zero-only false GREEN', (result) => { result.events = []; }],
  ['turn.completed false GREEN', (result) => { result.events = [{ value: { type: 'turn.completed' } }]; }],
  ['wrong Mission receipt', (result) => { result.events[1].value.missionId = 'foreign'; }],
  ['stale physical source SHA', (result) => { result.events[1].value.sourceDigest = digest('stale'); }],
]) {
  test(`independent process boundary rejects ${name}`, async () => {
    const fixture = harness();
    fixture.state.mutate = change;
    const result = await fixture.port.dispatch(fixture.request);
    assert.equal(result.status, 'rejected');
    noTerminal(result);
  });
}
test('foreign invocation credential cannot spawn', async () => {
  const fixture = harness();
  fixture.request.dispatch.credential.missionId = 'foreign';
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'rejected');
  assert.equal(fixture.state.calls, 0);
});
test('stale source before prepare cannot spawn or mutate journal', async () => {
  const fixture = harness();
  fixture.state.source = digest('stale');
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'rejected');
  assert.equal(fixture.state.calls, 0);
  assert.equal(fixture.state.prepares, 0);
});
test('expired admission lease cannot spawn', async () => {
  const fixture = harness();
  fixture.state.leaseValid = false;
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'rejected');
  assert.equal(fixture.state.calls, 0);
});
test('provenance denial prevents trusting matching worker events', async () => {
  const fixture = harness();
  fixture.state.provenance = false;
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'rejected');
  assert.equal(fixture.state.physicalChecks, 1);
});
test('ambiguous timeout is unknown and cannot replay', async () => {
  const fixture = harness();
  fixture.state.mutate = (result) => { result.outcome = 'timed-out'; };
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'unknown');
  assert.equal((await fixture.port.dispatch(fixture.request)).status, 'unknown');
  assert.equal(fixture.state.calls, 1);
});

test('unknown executor outcome must remain unknown, not an observed verified process', async () => {
  const fixture = harness();
  fixture.state.mutate = (result) => { result.outcome = 'unrecognized-provider-outcome'; result.events = []; result.pid = null; };
  const result = await fixture.port.dispatch(fixture.request);
  console.log(`QA_UNKNOWN_OUTCOME ${JSON.stringify(result)}`);
  noTerminal(result);
  assert.equal(result.status, 'unknown');
});
for (const boundary of ['lease', 'source']) {
  test(`${boundary} revoked during awaited live-effect read must prevent executor call`, async () => {
    const fixture = harness();
    let reads = 0;
    fixture.options.readEffect = async () => {
      reads += 1;
      if (reads === 1) {
        if (boundary === 'lease') fixture.state.leaseValid = false;
        else fixture.state.source = digest('drift-during-await');
      }
      return structuredClone(fixture.request.effect);
    };
    const result = await fixture.port.dispatch(fixture.request);
    console.log(`QA_AUTHORITY_GAP ${JSON.stringify({ boundary, calls: fixture.state.calls, status: result.status })}`);
    assert.equal(result.status, 'unknown');
    assert.equal(fixture.state.calls, 0, 'revoked authority must fail before the process side effect, not only after it');
  });
}

test('independent worker report exact-schema and trusted-binding publication preflight', () => {
  const result = JSON.parse(readFileSync(new URL('m2-r7-qa-codex-binding-result.json', validation), 'utf8'));
  assert.deepEqual(Object.keys(result).sort(), [
    'schema', 'task_key', 'project', 'attempt_id', 'session_id', 'producer', 'outcome', 'summary', 'functional_delta',
    'checks', 'changed_files', 'evidence_refs', 'remaining', 'questions', 'next_action', 'acceptance', 'recorded_at',
  ].sort());
  assert.equal(result.schema, 'go-core.worker-result.v1');
  assert.equal(result.task_key, 'ruflo-upstream-dev:m2-r8:qa-codex-binding:goal');
  assert.equal(result.project, 'ruflo-upstream-dev');
  assert.equal(result.attempt_id, 'attempt-366924f2-f355-4ed6-8c8e-6ea3f42c5826');
  assert.equal(result.session_id, 'manual-20261015-ruflo-native-m2-r8-independent-qa-five-goal');
  assert.deepEqual(result.producer, { thread_id: null, role: 'implementer' });
  assert.equal(result.outcome, 'REPAIR_REQUIRED');
  assert.deepEqual(result.acceptance, { level: 'UNACCEPTED' });
  assert.deepEqual([...result.changed_files].sort(), [
    'v3/@claude-flow/cli/__tests__/missions/m2-r7-qa-codex-binding.test.mjs',
    'v3/docs/validation/m2-r7-qa-codex-binding-result.json',
  ].sort());
  for (const field of ['functional_delta', 'evidence_refs', 'remaining', 'questions']) {
    assert.ok(Array.isArray(result[field]));
    assert.ok(result[field].every((value) => typeof value === 'string'));
  }
  for (const field of ['summary', 'next_action', 'recorded_at']) assert.ok(typeof result[field] === 'string' && result[field].length > 0);
  assert.equal(new Date(result.recorded_at).toISOString(), result.recorded_at);
  assert.ok(result.checks.length > 0);
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['evidence_ref', 'name', 'status']);
    assert.ok(['PASS', 'FAIL', 'BLOCKED'].includes(check.status));
    assert.ok(typeof check.name === 'string' && check.name.length > 0);
    assert.ok(typeof check.evidence_ref === 'string' && check.evidence_ref.length > 0);
  }
  assert.ok(result.evidence_refs.includes(`qa_test_sha256=${sha(readFileSync(new URL(import.meta.url)))}`));
  assert.ok(result.evidence_refs.includes(`producer_source_sha256=${sha(readFileSync(new URL('execution-m2-r7-codex-port.ts', missions)))}`));
});

test('fresh immutable QA source, artifact and test digest receipts', () => {
  for (const name of ['execution-m2-r7-codex-port.ts', 'execution-dispatch-binding.ts', 'execution-effect-guard.ts', 'execution-invocation-journal.ts', 'codex-executor.ts']) {
    console.log(`QA_SOURCE_SHA256 ${name} ${sha(readFileSync(new URL(name, missions)))}`);
  }
  for (const name of ['m2-r7-codex-binding-result.json', 'm2-r8-producer-receipts.json']) {
    console.log(`QA_ARTIFACT_SHA256 ${name} ${sha(readFileSync(new URL(name, validation)))}`);
  }
  console.log(`QA_TEST_SHA256 ${sha(readFileSync(new URL(import.meta.url)))}`);
  console.log(`QA_RECORDED_AT ${new Date().toISOString()}`);
});
