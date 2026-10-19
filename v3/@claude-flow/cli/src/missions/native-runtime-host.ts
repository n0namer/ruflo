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
import { MissionService, type Channel, type NativeRuntimeEventType, type NativeEventProof } from './service.js';
import type { MissionView } from './transitions.js';
import type { ExecutionAdmissionRequest } from './execution-admission.js';

export interface NativeMissionHost {
  /** Rechecked for every admitted transition; an unavailable worker fails closed. */
  readonly durableExecutorReady: () => boolean;
  /** Source-bound evidence, produced only by the trusted process owner. */
  readonly executionAdmission: (
    view: MissionView, action: 'admit' | 'resume',
  ) => ExecutionAdmissionRequest | null | Promise<ExecutionAdmissionRequest | null>;
  /** Authenticated Native event authority, not exposed to CLI or MCP transport. */
  readonly authorizeRuntimeEvent?: (
    view: MissionView, type: NativeRuntimeEventType, payload: Readonly<Record<string, unknown>>,
  ) => NativeEventProof | null | Promise<NativeEventProof | null>;
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
      executionAdmission: async (view: MissionView, action: 'admit' | 'resume') => {
        // Host revocation may race an asynchronous policy check: fence both sides.
        if (nativeHost !== host || !host.durableExecutorReady()) return null;
        const evidence = await host.executionAdmission(view, action);
        if (nativeHost !== host || !host.durableExecutorReady()) return null;
        return evidence;
      },
    } : {}),
  });
}


/**
 * Private Native executor ingress. The stock CLI/MCP adapters deliberately never
 * expose recordNativeEvent; only a bootstrapped runtime with its own verifier
 * can write observations or independent-QA terminal evidence.
 */
export function nativeMissionRuntimeService(projectRoot: string): MissionService {
  const host = nativeHost;
  return new MissionService({
    projectRoot,
    channel: 'internal',
    ...(host?.authorizeRuntimeEvent ? {
      authorizeRuntimeEvent: async (
        view: MissionView, type: NativeRuntimeEventType, payload: Readonly<Record<string, unknown>>,
      ): Promise<NativeEventProof | null> => {
        if (nativeHost !== host || !host.durableExecutorReady()) return null;
        const proof = await host.authorizeRuntimeEvent!(view, type, payload);
        if (nativeHost !== host || !host.durableExecutorReady()) return null;
        return proof;
      },
    } : {}),
  });
}
