import { describe, expect, it } from 'vitest';
import {
  FrontierError,
  authorizeQaTerminal,
  createMissionFrontier,
  markRunning,
  replanAffected,
  refillReady,
} from '../../src/missions/execution-frontier.js';

const graph = [
  { id: 'build' },
  { id: 'qa', dependsOn: ['build'] },
  { id: 'publish', dependsOn: ['qa'] },
  { id: 'docs' },
] as const;

describe('execution frontier', () => {
  it('derives dependency order and refills only newly ready work', () => {
    const initial = createMissionFrontier(graph);
    expect(initial.ready).toEqual(['build', 'docs']);
    expect(initial.running).toEqual([]);
    const running = markRunning(initial, 'build');
    expect(running.ready).toEqual(['docs']);
    const completed = authorizeQaTerminal(running, 'build', {
      authorized: true,
      authorizationRef: 'qa-run-1',
      terminalStatus: 'succeeded',
    }, 0);
    expect(completed.terminal).toEqual(['build']);
    expect(completed.ready).toEqual(['qa', 'docs']);
    expect(completed.tasks.publish.status).toBe('pending');
  });

  it('does not let an exit code alone create a terminal task', () => {
    const running = markRunning(createMissionFrontier(graph), 'build');
    expect(() => authorizeQaTerminal(running, 'build', {
      authorized: false,
      authorizationRef: '',
      terminalStatus: 'succeeded',
    }, 0)).toThrowError(new FrontierError(
      'unauthorized-terminal',
      'QA authorization is required for task build',
    ));
    expect(running.tasks.build.status).toBe('running');
  });

  it('requires an authorized QA terminal for both success and failure', () => {
    let frontier = markRunning(createMissionFrontier(graph), 'build');
    frontier = authorizeQaTerminal(frontier, 'build', {
      authorized: true,
      authorizationRef: 'qa-failure',
      terminalStatus: 'failed',
    }, 17);
    expect(frontier.tasks.build).toMatchObject({ status: 'failed', exitCode: 17, qaAuthorization: 'qa-failure' });
    expect(frontier.ready).not.toContain('qa');
    expect(frontier.tasks.qa.status).toBe('pending');
  });

  it('rejects duplicate IDs, repeated dependencies, unknown dependencies, and cycles', () => {
    expect(() => createMissionFrontier([{ id: 'x' }, { id: 'x' }])).toThrow(/duplicate task id/);
    expect(() => createMissionFrontier([{ id: 'x', dependsOn: ['x', 'x'] }])).toThrow(/repeats a dependency/);
    expect(() => createMissionFrontier([{ id: 'x', dependsOn: ['missing'] }])).toThrow(/unknown task/);
    expect(() => createMissionFrontier([{ id: 'x', dependsOn: ['x'] }])).toThrow(/cycle/);
    expect(() => createMissionFrontier([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toThrow(/cycle/);
  });

  it('replans the changed task and all dependent descendants only', () => {
    const original = createMissionFrontier(graph, {
      docs: 'running',
    });
    const replanned = replanAffected(original, ['build'], [
      { id: 'build' },
      { id: 'qa', dependsOn: ['build'] },
      { id: 'publish', dependsOn: ['qa'] },
      { id: 'docs' },
    ]);
    expect(replanned.tasks.docs.status).toBe('running');
    expect(replanned.tasks.build.status).toBe('ready');
    expect(replanned.tasks.qa.status).toBe('pending');
    expect(replanned.tasks.publish.status).toBe('pending');
    expect(replanned.ready).toEqual(['build']);
  });

  it('supports explicit refill after a dependency becomes terminal', () => {
    const frontier = createMissionFrontier(graph, {
      build: 'succeeded',
      qa: 'pending',
      publish: 'pending',
      docs: 'running',
    });
    expect(frontier.ready).toEqual(['qa']);
    expect(refillReady(frontier)).toEqual(frontier);
  });

  it('derives readiness instead of trusting a forged ready status', () => {
    const frontier = createMissionFrontier(graph, { qa: 'ready' });
    expect(frontier.tasks.qa.status).toBe('pending');
    expect(frontier.ready).toEqual(['build', 'docs']);
  });

  it('preserves prototype-sensitive IDs and their dependency edges', () => {
    const frontier = createMissionFrontier([
      { id: '__proto__' },
      { id: 'constructor', dependsOn: ['__proto__'] },
      { id: 'toString', dependsOn: ['constructor'] },
    ]);

    expect(Object.getPrototypeOf(frontier.tasks)).toBeNull();
    expect(Object.keys(frontier.tasks)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(frontier.ready).toEqual(['__proto__']);
    expect(frontier.tasks.constructor.status).toBe('pending');
    expect(frontier.tasks.toString.status).toBe('pending');

    const running = markRunning(frontier, '__proto__');
    const completed = authorizeQaTerminal(running, '__proto__', {
      authorized: true,
      authorizationRef: 'qa:independent-receipt',
      terminalStatus: 'succeeded',
    });
    expect(completed.ready).toEqual(['constructor']);
    expect(completed.tasks.toString.status).toBe('pending');
  });

  it('rejects invalid lifecycle operations', () => {
    const frontier = createMissionFrontier(graph);
    expect(() => markRunning(frontier, 'qa')).toThrow(/not ready/);
    expect(() => markRunning(frontier, 'missing')).toThrow(/unknown task/);
    expect(() => authorizeQaTerminal(frontier, 'build', {
      authorized: true,
      authorizationRef: 'qa',
      terminalStatus: 'succeeded',
    })).toThrow(/not running/);
  });
});
