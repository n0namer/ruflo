import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexExecutor, runCodexMission, type CodexAdmission } from '../../src/missions/codex-executor.js';

const admission: CodexAdmission = {
  missionId: 'msn_test',
  taskId: 'task-1',
  leaseEpoch: 3,
  authorizationRef: 'auth:1',
  planDigest: 'sha256:test',
};

const request = (prompt = 'do work') => ({ prompt, admission });

describe('native stock Codex mission executor', () => {
  it('runs the upstream codex executable with JSONL and shell:false, retaining PID and process evidence', async () => {
    const result = await new CodexExecutor({
      command: process.execPath,
      commandPrefixArgs: ['-e', 'process.stdout.write(JSON.stringify({type:"result",ok:true}) + "\\n")'],
      timeoutMs: 2_000,
    }).run(request('console.log({ok:true})'));

    expect(result.outcome).toBe('completed');
    expect(result.pid).toEqual(expect.any(Number));
    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual([{ raw: '{"type":"result","ok":true}', value: { type: 'result', ok: true }, line: 1 }]);
    expect(result.settlement).toBe('observation-required');
    expect(result.terminationConfirmed).toBe(true);
  });

  it('uses shell:false for the reusable subprocess boundary', async () => {
    let observedShell: unknown;
    const result = await new CodexExecutor({
      command: process.execPath,
      commandPrefixArgs: ['-e', 'process.stdout.write("{}\\n")'],
      spawn: (command, args, options) => {
        observedShell = options.shell;
        return spawn(command, args, options) as never;
      },
    }).run(request());

    expect(result.outcome).toBe('completed');
    expect(observedShell).toBe(false);
  });

  it('rejects all reported approval and sandbox bypass spellings before spawning', async () => {
    const probes = [
      ['--sandbox', 'danger-full-access'],
      ['--ask-for-approval', 'never'],
      ['--dangerously-bypass-approvals-and-sandbox=true'],
      ['--yolo=true'],
    ];

    for (const extraArgs of probes) {
      let spawned = false;
      const executor = new CodexExecutor({
        spawn: () => {
          spawned = true;
          throw new Error('must not spawn');
        },
      });
      await expect(executor.run({ ...request(), extraArgs })).rejects.toThrow('allowlist');
      expect(spawned).toBe(false);
    }
  });

  it('rejects restricted policy overrides from command prefixes, including short and camel forms', async () => {
    const probes = [
      ['--sandbox', 'danger-full-access'],
      ['--ask-for-approval', 'never'],
      ['--dangerouslyBypassApprovalsAndSandbox=true'],
      ['--yolo=true'],
      ['-s', 'danger-full-access'],
      ['--config=x'],
      ['--baseURL=x'],
      ['-m', 'unsafe'],
    ];
    for (const commandPrefixArgs of probes) {
      await expect(new CodexExecutor({ commandPrefixArgs }).run(request())).rejects.toThrow('commandPrefixArgs');
    }
  });

  it('keeps malformed JSONL as evidence instead of treating it as a terminal task outcome', async () => {
    const result = await new CodexExecutor({
      command: process.execPath,
      commandPrefixArgs: ['-e', 'process.stdout.write("not-json\\n" + JSON.stringify({step:"done"}) + "\\n"); process.exit(7)'],
    }).run(request());

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(result.invalidJsonlLines).toEqual(['not-json']);
    expect(result.events[0]?.value).toEqual({ step: 'done' });
    expect(result.settlement).toBe('observation-required');
  });

  it('returns timed-out with PID evidence and does not convert timeout into mission failure', async () => {
    const result = await new CodexExecutor({
      command: process.execPath,
      commandPrefixArgs: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 100,
      // Windows process close events can be delayed when Vitest saturates CPU.
      // Keep a bounded but realistic grace period before declaring unknown termination.
      killGraceMs: 500,
    }).run(request());

    expect(result.outcome).toBe('timed-out');
    expect(result.pid).toEqual(expect.any(Number));
    expect(result.exitCode).toBeNull();
    expect(result.settlement).toBe('observation-required');
    expect(result.terminationConfirmed).toBe(true);
  });

  it('reports spawn errors without bypassing admission or inventing a terminal state', async () => {
    const result = await new CodexExecutor({ command: 'definitely-not-a-real-codex-command' }).run(request());

    expect(result.outcome).toBe('spawn-error');
    expect(result.pid).toBeNull();
    expect(result.settlement).toBe('observation-required');
  });

  it('rejects missing admission before spawning', async () => {
    let spawned = false;
    const executor = new CodexExecutor({
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });

    await expect(executor.run({ prompt: 'x', admission: undefined as never })).rejects.toThrow('admission');
    expect(spawned).toBe(false);
  });

  it('supports the reusable function facade and rejects empty prompts', async () => {
    await expect(runCodexMission({ ...request(''), admission })).rejects.toThrow('prompt');
  });
});
