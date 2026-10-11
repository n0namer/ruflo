/**
 * Native stock Mission Codex subprocess adapter.
 *
 * This module owns process mechanics only. Admission is supplied by the
 * mission runtime; process completion is an observation and never settles a
 * mission or task by itself.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

export interface CodexAdmission {
  readonly missionId: string;
  readonly taskId: string;
  readonly leaseEpoch: number;
  readonly authorizationRef: string;
  readonly planDigest: string;
}

export interface CodexExecutorRequest {
  readonly prompt: string;
  readonly admission: CodexAdmission;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export interface CodexJsonlEvent {
  readonly raw: string;
  readonly value: unknown;
  readonly line: number;
}

export type CodexProcessOutcome = 'completed' | 'failed' | 'timed-out' | 'spawn-error';

export interface CodexExecutorResult {
  readonly outcome: CodexProcessOutcome;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: readonly CodexJsonlEvent[];
  readonly invalidJsonlLines: readonly string[];
  readonly durationMs: number;
  readonly admission: CodexAdmission;
  /** Process evidence must be reconciled by the mission runtime before settlement. */
  readonly settlement: 'observation-required';
  /** False means termination could not be confirmed within both grace windows. */
  readonly terminationConfirmed: boolean;
}

export interface CodexExecutorOptions {
  readonly command?: string;
  /** Arguments placed before the stock Codex argv; useful for compatible wrappers. */
  readonly commandPrefixArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly spawn?: SpawnLike;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 250;
const CODEX_ARGS = ['exec', '--json', '--skip-git-repo-check'] as const;
const SAFE_EXTRA_ARGS = new Set(['--json', '--skip-git-repo-check']);
const RESTRICTED_OPTION_KEYS = new Set([
  'a', 'askforapproval', 'approval', 'b', 'baseurl', 'c', 'config',
  'dangerouslybypassapprovalsandsandbox', 'm', 'model', 'modelprovider',
  'provider', 's', 'sandbox', 'yolo',
]);
function invalid(message: string): never {
  throw new TypeError(message);
}

function validateAdmission(admission: CodexAdmission): void {
  if (!admission || typeof admission !== 'object') invalid('codex admission is required');
  for (const key of ['missionId', 'taskId', 'authorizationRef', 'planDigest'] as const) {
    if (typeof admission[key] !== 'string' || admission[key].trim() === '') {
      invalid(`codex admission.${key} is required`);
    }
  }
  if (!Number.isInteger(admission.leaseEpoch) || admission.leaseEpoch < 0) {
    invalid('codex admission.leaseEpoch must be a non-negative integer');
  }
}

function optionKey(argument: string): string {
  return argument.split('=', 1)[0].replace(/^-+/, '').replace(/[-_]/g, '').toLowerCase();
}

function isRestrictedOption(argument: string): boolean {
  const key = optionKey(argument);
  return RESTRICTED_OPTION_KEYS.has(key)
    || key.includes('sandbox')
    || key.includes('approval')
    || key.includes('baseurl')
    || key.includes('provider')
    || key.includes('model');
}

function validateRequest(request: CodexExecutorRequest): void {
  if (!request || typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    invalid('codex prompt is required');
  }
  validateAdmission(request.admission);
  if (request.extraArgs?.some((arg) => typeof arg !== 'string' || !SAFE_EXTRA_ARGS.has(arg))) {
    invalid('codex extraArgs must use the non-mutating allowlist');
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    invalid('codex timeoutMs must be positive');
  }
}

function splitJsonl(stdout: string): { events: CodexJsonlEvent[]; invalid: string[] } {
  const events: CodexJsonlEvent[] = [];
  const invalidLines: string[] = [];
  const lines = stdout.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    try {
      events.push({ raw: line, value: JSON.parse(line) as unknown, line: index + 1 });
    } catch {
      invalidLines.push(line);
    }
  });
  return { events, invalid: invalidLines };
}

function terminate(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let finalTimer: NodeJS.Timeout | undefined;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      resolve(confirmed);
    };
    child.once('close', () => finish(true));
    forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* preserve unconfirmed observation */ }
      finalTimer = setTimeout(() => finish(false), graceMs);
    }, graceMs);
    try { child.kill('SIGTERM'); } catch { /* escalation timer still runs */ }
  });
}

export class CodexExecutor {
  private readonly command: string;
  private readonly commandPrefixArgs: readonly string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly spawnProcess: SpawnLike;

  constructor(options: CodexExecutorOptions = {}) {
    this.command = options.command ?? 'codex';
    this.commandPrefixArgs = options.commandPrefixArgs ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
  }

  async run(request: CodexExecutorRequest): Promise<CodexExecutorResult> {
    validateRequest(request);
    if (this.commandPrefixArgs.some((arg) => typeof arg !== 'string' || isRestrictedOption(arg))) {
      invalid('codex commandPrefixArgs cannot alter approval, sandbox, config, provider, or model policy');
    }
    const started = Date.now();
    const args = [...this.commandPrefixArgs, ...CODEX_ARGS, ...(request.extraArgs ?? []), request.prompt];
    const admission = request.admission;
    const cwd = request.cwd ?? this.cwd;
    const spawnOptions: SpawnOptions = {
      cwd,
      env: { ...process.env, ...this.env, FORCE_COLOR: '0' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.command, args, spawnOptions);
    } catch (error) {
      return {
        outcome: 'spawn-error',
        pid: null,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        events: [],
        invalidJsonlLines: [],
        durationMs: Date.now() - started,
        admission,
        settlement: 'observation-required',
        terminationConfirmed: true,
      };
    }

    const pid = child.pid ?? null;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; terminationConfirmed: boolean }>((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        const terminationConfirmed = await terminate(child, this.killGraceMs);
        resolve({ exitCode: null, signal: 'SIGTERM', terminationConfirmed });
      }, request.timeoutMs ?? this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, terminationConfirmed: true });
      });
      child.stdin.end();
    }).catch((error) => ({
      exitCode: null,
      signal: null,
      terminationConfirmed: true,
      error: error instanceof Error ? error.message : String(error),
    }));

    const parsed = splitJsonl(stdout);
    const processError = 'error' in result ? result.error : undefined;
    return {
      outcome: timedOut ? 'timed-out' : processError ? 'spawn-error' : result.exitCode === 0 ? 'completed' : 'failed',
      pid,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout,
      stderr: processError ? [stderr, processError].filter(Boolean).join('\n') : stderr,
      events: parsed.events,
      invalidJsonlLines: parsed.invalid,
      durationMs: Date.now() - started,
      admission,
      settlement: 'observation-required',
      terminationConfirmed: result.terminationConfirmed,
    };
  }
}

export async function runCodexMission(request: CodexExecutorRequest, options?: CodexExecutorOptions): Promise<CodexExecutorResult> {
  return new CodexExecutor(options).run(request);
}
