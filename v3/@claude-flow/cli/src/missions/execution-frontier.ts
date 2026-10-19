/**
 * Stock mission execution frontier.
 *
 * This module is deliberately a pure planning/state utility. Authorization and
 * QA proof are explicit inputs; process exit codes are never authority.
 */

export type MissionTaskStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked';
export type TerminalTaskStatus = Extract<MissionTaskStatus, 'succeeded' | 'failed'>;

export interface MissionTask {
  readonly id: string;
  readonly dependsOn?: readonly string[];
}

export interface TaskState {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly status: MissionTaskStatus;
  readonly exitCode?: number;
  readonly qaAuthorization?: string;
}

export interface MissionFrontier {
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly ready: readonly string[];
  readonly running: readonly string[];
  readonly terminal: readonly string[];
}

export interface QaTerminalAuthorization {
  readonly authorized: boolean;
  readonly authorizationRef: string;
  readonly terminalStatus: TerminalTaskStatus;
}

export class FrontierError extends Error {
  constructor(readonly code: 'duplicate-task' | 'unknown-dependency' | 'cycle' | 'unknown-task' | 'invalid-transition' | 'unauthorized-terminal', message: string) {
    super(`${code}: ${message}`);
    this.name = 'FrontierError';
  }
}

function assertId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new FrontierError('unknown-task', 'task id must be a non-empty string');
}

function hasOwn<T>(record: Readonly<Record<string, T>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function taskMap(): Record<string, TaskState> {
  return Object.create(null) as Record<string, TaskState>;
}

function normalizeTasks(tasks: readonly MissionTask[]): MissionTask[] {
  const ids = new Set<string>();
  return tasks.map((task) => {
    assertId(task.id);
    if (ids.has(task.id)) throw new FrontierError('duplicate-task', `duplicate task id ${task.id}`);
    ids.add(task.id);
    const dependsOn = [...new Set(task.dependsOn ?? [])];
    if (dependsOn.length !== (task.dependsOn ?? []).length) {
      throw new FrontierError('duplicate-task', `task ${task.id} repeats a dependency`);
    }
    return { id: task.id, dependsOn };
  });
}

function validateGraph(tasks: readonly MissionTask[]): MissionTask[] {
  const normalized = normalizeTasks(tasks);
  const ids = new Set(normalized.map((task) => task.id));
  for (const task of normalized) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new FrontierError('unknown-dependency', `task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const indegree = new Map(normalized.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(normalized.map((task) => [task.id, [] as string[]]));
  for (const task of normalized) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  const queue = normalized.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const dependent of dependents.get(id)!) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== normalized.length) throw new FrontierError('cycle', 'mission task graph contains a cycle');
  return normalized;
}

function derive(tasks: Readonly<Record<string, TaskState>>): MissionFrontier {
  const entries = Object.values(tasks);
  const ready = entries.filter((task) => task.status === 'ready').map((task) => task.id);
  const running = entries.filter((task) => task.status === 'running').map((task) => task.id);
  const terminal = entries.filter((task) => task.status === 'succeeded' || task.status === 'failed').map((task) => task.id);
  return { tasks, ready, running, terminal };
}

function dependencyReady(task: TaskState, tasks: Readonly<Record<string, TaskState>>): boolean {
  return task.dependsOn.every((dependency) => tasks[dependency].status === 'succeeded');
}

export function createMissionFrontier(
  taskDefinitions: readonly MissionTask[],
  previous: Readonly<Record<string, MissionTaskStatus | TaskState>> = {},
): MissionFrontier {
  const graph = validateGraph(taskDefinitions);
  const tasks = taskMap();
  for (const task of graph) {
    const prior = hasOwn(previous, task.id) ? previous[task.id] : undefined;
    const suppliedStatus = typeof prior === 'string' ? prior : prior?.status ?? 'pending';
    // Readiness is derived from dependencies, never accepted as caller authority.
    const status = suppliedStatus === 'ready' ? 'pending' : suppliedStatus;
    tasks[task.id] = {
      id: task.id,
      dependsOn: [...task.dependsOn],
      status,
      ...(typeof prior === 'string' ? {} : prior?.exitCode === undefined ? {} : { exitCode: prior.exitCode }),
      ...(typeof prior === 'string' || !prior || prior.qaAuthorization === undefined ? {} : { qaAuthorization: prior.qaAuthorization }),
    };
  }
  for (const task of graph) {
    if (tasks[task.id].status === 'pending' && dependencyReady(tasks[task.id], tasks)) {
      tasks[task.id] = { ...tasks[task.id], status: 'ready' };
    }
  }
  return derive(tasks);
}

export function refillReady(frontier: MissionFrontier): MissionFrontier {
  const tasks = taskMap();
  for (const [id, task] of Object.entries(frontier.tasks)) {
    tasks[id] = task.status === 'pending' && dependencyReady(task, frontier.tasks)
      ? { ...task, status: 'ready' }
      : task;
  }
  return derive(tasks);
}

export function markRunning(frontier: MissionFrontier, taskId: string): MissionFrontier {
  const task = hasOwn(frontier.tasks, taskId) ? frontier.tasks[taskId] : undefined;
  if (!task) throw new FrontierError('unknown-task', `unknown task ${taskId}`);
  if (task.status !== 'ready') throw new FrontierError('invalid-transition', `task ${taskId} is not ready`);
  const tasks = taskMap();
  for (const [id, state] of Object.entries(frontier.tasks)) tasks[id] = state;
  tasks[taskId] = { ...task, status: 'running' };
  return derive(tasks);
}

export function authorizeQaTerminal(
  frontier: MissionFrontier,
  taskId: string,
  authorization: QaTerminalAuthorization,
  exitCode?: number,
): MissionFrontier {
  const task = hasOwn(frontier.tasks, taskId) ? frontier.tasks[taskId] : undefined;
  if (!task) throw new FrontierError('unknown-task', `unknown task ${taskId}`);
  if (task.status !== 'running') throw new FrontierError('invalid-transition', `task ${taskId} is not running`);
  // The caller must supply an authoritative independent-QA receipt verified by
  // Native before invoking this pure utility; this module does not authenticate
  // reviewers, sign receipts, or complete the Native lifecycle itself.
  if (authorization?.authorized !== true || !authorization.authorizationRef) {
    throw new FrontierError('unauthorized-terminal', `QA authorization is required for task ${taskId}`);
  }
  if (authorization.terminalStatus !== 'succeeded' && authorization.terminalStatus !== 'failed') {
    throw new FrontierError('unauthorized-terminal', 'QA terminal status must be succeeded or failed');
  }
  const tasks = taskMap();
  for (const [id, state] of Object.entries(frontier.tasks)) tasks[id] = state;
  tasks[taskId] = {
    ...task,
    status: authorization.terminalStatus,
    ...(exitCode === undefined ? {} : { exitCode }),
    qaAuthorization: authorization.authorizationRef,
  };
  return refillReady(derive(tasks));
}

export function affectedTaskIds(frontier: MissionFrontier, changedTaskIds: readonly string[]): readonly string[] {
  const changed = new Set(changedTaskIds);
  for (const id of changed) {
    if (!hasOwn(frontier.tasks, id)) throw new FrontierError('unknown-task', `unknown task ${id}`);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of Object.values(frontier.tasks)) {
      if (!changed.has(task.id) && task.dependsOn.some((dependency) => changed.has(dependency))) {
        changed.add(task.id);
        expanded = true;
      }
    }
  }
  return Object.keys(frontier.tasks).filter((id) => changed.has(id));
}

export function replanAffected(
  frontier: MissionFrontier,
  changedTaskIds: readonly string[],
  replacement?: readonly MissionTask[],
): MissionFrontier {
  const affected = new Set(affectedTaskIds(frontier, changedTaskIds));
  const definitions = replacement ?? Object.values(frontier.tasks).map(({ id, dependsOn }) => ({ id, dependsOn }));
  const rebuilt = createMissionFrontier(definitions);
  const tasks = taskMap();

  // A replacement is a complete candidate graph. New nodes are necessarily
  // affected, while existing unaffected nodes retain their runtime state.
  for (const [id, task] of Object.entries(rebuilt.tasks)) {
    const prior = hasOwn(frontier.tasks, id) ? frontier.tasks[id] : undefined;
    tasks[id] = !prior || affected.has(id) ? task : prior;
  }

  return refillReady(derive(tasks));
}


/**
 * Derive the actionable READY slice from the authoritative MissionStore view,
 * using the existing stock DAG/frontier implementation. This is a read-only
 * refill decision; the Native host must still enforce policy/lease/journal
 * before launching each physical Codex invocation.
 */
export function readyTaskIdsFromMission(
  view: Pick<import('./transitions.js').MissionView, 'record' | 'planBody' | 'tasks'>,
  limit = 1,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new RangeError('READY concurrency limit must be between 1 and 64');
  }
  if (!view.planBody || view.record.executionMode !== 'durable-executor'
    || !['queued', 'running'].includes(view.record.state)) return [];
  const previous: Record<string, MissionTaskStatus> = Object.create(null);
  for (const task of view.planBody.tasks) {
    const status = view.tasks[task.id]?.status ?? 'pending';
    previous[task.id] = status === 'recorded-done' ? 'succeeded'
      : status === 'unknown' ? 'blocked' : status;
  }
  const frontier = createMissionFrontier(
    view.planBody.tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn })),
    previous,
  );
  return frontier.ready.slice(0, limit);
}
