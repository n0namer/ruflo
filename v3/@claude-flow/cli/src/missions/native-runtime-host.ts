/**
 * ADR-406 M2 process-local host integration, not a second MissionStore or runner.
 * A genuine durable Native host must register its independently verified
 * execution authority at bootstrap. No CLI/MCP argument or environment toggle
 * installs grants, selects an executor, or authorizes a Mission.
 *
 * Registration by itself is NOT authorization: the injected host remains
 * responsible for authenticating live policy, budget, worktree and permission
 * receipts, and for dispatching through the existing M2 journal/lease/Codex path.
 */
import { MissionService, type Channel } from './service.js';
import type { MissionView } from './transitions.js';
import type { ExecutionAdmissionRequest } from './execution-admission.js';

export interface NativeMissionHost {
  /** Rechecked for every admitted transition; an unavailable worker fails closed. */
  readonly durableExecutorReady: () => boolean;
  /** Source-bound evidence, produced only by the trusted process owner. */
  readonly executionAdmission: (
    view: MissionView, action: 'admit' | 'resume',
  ) => ExecutionAdmissionRequest | null;
}

let nativeHost: NativeMissionHost | null = null;

/**
 * Bootstrap-only entrypoint. The untrusted CLI/MCP payload cannot call this;
 * callers MUST keep runtime setup within their authenticated host boundary.
 */
export function installNativeMissionHost(host: NativeMissionHost | null): void {
  if (host !== null && (typeof host?.durableExecutorReady !== 'function'
      || typeof host?.executionAdmission !== 'function')) {
    throw new TypeError('Native Mission host requires readiness and admission evidence callbacks');
  }
  nativeHost = host;
}

/** Shared source of MissionService authority across CLI and MCP adapters. */
export function nativeMissionService(projectRoot: string, channel: Channel): MissionService {
  const host = nativeHost;
  return new MissionService({
    projectRoot,
    channel,
    ...(host ? {
      executionAdmission: (view: MissionView, action: 'admit' | 'resume') => {
        // Re-read current registration and readiness: removing/revoking it is immediate.
        if (nativeHost !== host || !host.durableExecutorReady()) return null;
        return host.executionAdmission(view, action);
      },
    } : {}),
  });
}
