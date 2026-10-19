/**
 * ADR-406 M2 factory bridge: existing MissionStore + bounded READY cycle.
 * No background scheduler, new authority, memory cache or second journal.
 * A trusted resident bootstrap must supply official Codex/QA/lease ports;
 * CLI/MCP users cannot install these callbacks as request parameters.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { MissionStore } from './store.js';
import { runNativeReadyCycle } from './native-ready-cycle.js';
import type { NativeReadyCycleOptions } from './native-ready-cycle.js';

const MISSION_ID = /^msn_[a-f0-9]{24}$/;
function exactRoot(candidate: string, approved: string): boolean {
  try {
    const normalize = (value: string) => realpathSync(resolve(value)).replaceAll('\\','/').toLowerCase();
    return normalize(candidate) === normalize(approved);
  } catch { return false; }
}

export type TrustedNativeM2Ports =
  Omit<NativeReadyCycleOptions, 'projectRoot' | 'missionId' | 'maxTasks' | 'beforeDispatch'> & {
    /** Bound once by the resident host, not by untrusted CLI arguments. */
    readonly projectRoot: string;
  };

export function createNativeM2FactoryDriver(ports: TrustedNativeM2Ports) {
  if (!ports || typeof ports.projectRoot !== 'string' ||
      typeof ports.runtime?.recordNativeEvent !== 'function' ||
      typeof ports.dispatch !== 'function' || typeof ports.review !== 'function' ||
      typeof ports.settle !== 'function') {
    throw new TypeError('Native M2 factory driver requires trusted runtime, Codex and QA ports');
  }
  const root = realpathSync(resolve(ports.projectRoot));
  const read = (projectRoot: string, missionId: string) => {
    if (!MISSION_ID.test(missionId) || !exactRoot(projectRoot, root)) return null;
    const view = new MissionStore(root).loadView(missionId);
    return view ? {
      projectRoot: root,
      missionId: view.record.missionId,
      state: view.record.state,
      executionMode: view.record.executionMode,
      revision: view.record.revision,
    } : null;
  };
  return Object.freeze({
    async readMission({ projectRoot, missionId }: {projectRoot: string; missionId: string}) {
      return read(projectRoot, missionId);
    },
    async runOnce({ projectRoot, missionId, maxTasks, beforeDispatch }: {
      projectRoot: string;
      missionId: string;
      maxTasks: number;
      beforeDispatch: (taskId: string) => boolean | Promise<boolean>;
    }) {
      const mission = read(projectRoot, missionId);
      if (!mission || !['queued','running','verifying'].includes(mission.state) ||
          typeof beforeDispatch !== 'function') {
        return { status:'blocked' as const, missionId,
          performed: [] as string[], state: mission?.state ?? 'missing',
          reason:'untrusted-native-request' };
      }
      return runNativeReadyCycle({
        ...ports, projectRoot: root, missionId, maxTasks,
        beforeDispatch: (taskId) => beforeDispatch(taskId),
      });
    },
  });
}
