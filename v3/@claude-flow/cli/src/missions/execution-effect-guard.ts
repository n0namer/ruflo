/**
 * ADR-406 M2 effect-time authorization and resource fencing.
 *
 * This module is deliberately a pure guard. It does not execute effects,
 * mutate MissionStore, or mint permission/lease/revision authority. Native
 * callers must supply authenticated preflight and live snapshots; the live
 * snapshot is checked again immediately before the caller performs its effect.
 */

export interface EffectResourceScope {
  readonly root: string;
  readonly resource: string;
  readonly canonicalRoot?: string;
  readonly canonicalResource?: string;
}

export interface EffectPermission {
  readonly granted: boolean;
  /**
   * Authenticated by the trusted Native admission boundary; a reference string
   * alone is never sufficient authority.
   */
  readonly authenticated: boolean;
  readonly capability: string;
  readonly authorizationRef: string;
}

export interface EffectFence {
  readonly missionId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly revision: number;
}

export interface EffectGuardInput {
  readonly effectId: string;
  readonly permission: EffectPermission;
  readonly scope: EffectResourceScope;
  readonly fence: EffectFence;
}

export type EffectGuardCode =
  | 'invalid-input'
  | 'permission-revoked'
  | 'permission-evidence-missing'
  | 'scope-mismatch'
  | 'scope-evidence-missing'
  | 'stale-fence'
  | 'revision-conflict'
  | 'authority-mismatch';

export interface EffectPreflight {
  readonly effectId: string;
  readonly capability: string;
  readonly authorizationRef: string;
  readonly scope: EffectResourceScope;
  readonly fence: EffectFence;
}

export type EffectGuardDecision =
  | { readonly authorized: true; readonly token: EffectAuthorization }
  | { readonly authorized: false; readonly code: EffectGuardCode; readonly reason: string };

export interface EffectAuthorization {
  readonly effectId: string;
  readonly capability: string;
  readonly authorizationRef: string;
  readonly missionId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly revision: number;
  readonly resource: string;
}

function deny(code: EffectGuardCode, reason: string): EffectGuardDecision {
  return { authorized: false, code, reason };
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validId(value: unknown): value is string {
  return present(value) && value.length <= 256 && !/[\u0000\r\n]/u.test(value);
}

function isAbsolutePath(value: string): boolean {
  const slash = String.fromCharCode(92);
  return value.startsWith('/')
    || value.startsWith(slash + slash)
    || (value.length >= 3 && value[1] === ':' && (value[2] === '/' || value[2] === slash));
}

function normalizePath(value: string): string {
  const slash = String.fromCharCode(92);
  const slashified = value.split(slash).join('/');
  const unc = slashified.startsWith('//');
  let collapsed = slashified;
  while (collapsed.includes('//')) collapsed = collapsed.replaceAll('//', '/');
  return unc ? `/${collapsed}` : collapsed;
}

function pathKey(value: string): string {
  const normalized = normalizePath(value).replace(/\/$/u, '');
  // Windows drive and UNC paths are case-insensitive; POSIX paths are not.
  const windowsPath = (normalized.length >= 2 && normalized[1] === ':') || normalized.startsWith('//');
  return windowsPath ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function safePath(value: unknown): value is string {
  if (!present(value) || !isAbsolutePath(value)) return false;
  if (value.includes(String.fromCharCode(0)) || value.includes('\r') || value.includes('\n')) return false;
  const normalized = normalizePath(value);
  if (/%[0-9A-Fa-f]{2}/u.test(normalized)) return false;
  return normalized.split('/').every((part) => part !== '.' && part !== '..');
}

function within(root: string, resource: string): boolean {
  const r = pathKey(root);
  const candidate = pathKey(resource);
  return candidate === r || candidate.startsWith(r + '/');
}

function validScope(scope: EffectResourceScope): boolean {
  if (!safePath(scope?.root) || !safePath(scope?.resource) || !within(scope.root, scope.resource)) return false;
  const canonicalPair = (scope.canonicalRoot === undefined) === (scope.canonicalResource === undefined);
  if (!canonicalPair) return false;
  if (scope.canonicalRoot !== undefined
    && (!safePath(scope.canonicalRoot) || !safePath(scope.canonicalResource)
      || !within(scope.canonicalRoot, scope.canonicalResource))) return false;
  return true;
}

function sameScope(left: EffectResourceScope, right: EffectResourceScope): boolean {
  return left.root === right.root
    && left.resource === right.resource
    && left.canonicalRoot === right.canonicalRoot
    && left.canonicalResource === right.canonicalResource;
}

function validPermission(permission: EffectPermission): boolean {
  return permission?.granted === true
    && permission.authenticated === true
    && validId(permission.capability)
    && validId(permission.authorizationRef);
}

function validFence(fence: EffectFence): boolean {
  return validId(fence?.missionId)
    && validId(fence?.leaseId)
    && /^(?:0|[1-9][0-9]*)$/u.test(fence?.generation ?? '')
    && BigInt(fence.generation) > 0n
    && Number.isSafeInteger(fence.revision)
    && fence.revision >= 1;
}

export function preflightEffect(input: EffectGuardInput): EffectPreflight | EffectGuardDecision {
  if (!input || !validId(input.effectId)) return deny('invalid-input', 'effectId is required');
  if (!validPermission(input.permission)) {
    return deny(input.permission?.granted === false ? 'permission-revoked' : 'permission-evidence-missing',
      'an authenticated explicit permission grant is required');
  }
  if (!validScope(input.scope)) return deny('scope-evidence-missing', 'resource scope must be absolute, rooted, and alias-free');
  if (!validFence(input.fence)) return deny('invalid-input', 'mission lease and revision fence is malformed');
  return {
    effectId: input.effectId,
    capability: input.permission.capability,
    authorizationRef: input.permission.authorizationRef,
    scope: { ...input.scope },
    fence: { ...input.fence },
  };
}

export function authorizeEffect(preflight: EffectPreflight, live: EffectGuardInput): EffectGuardDecision {
  if (!preflight || !live || preflight.effectId !== live.effectId) {
    return deny('authority-mismatch', 'preflight and live effect identities differ');
  }
  if (!validPermission(live.permission) || live.permission.granted !== true) {
    return deny('permission-revoked', 'permission is no longer explicitly granted');
  }
  if (live.permission.capability !== preflight.capability
    || live.permission.authorizationRef !== preflight.authorizationRef) {
    return deny('authority-mismatch', 'live permission authority differs from preflight');
  }
  if (!validScope(live.scope) || !sameScope(preflight.scope, live.scope)) {
    return deny('scope-mismatch', 'live resource scope differs or is outside the authorized scope');
  }
  if (!validFence(live.fence)) return deny('stale-fence', 'live mission fence is malformed or unavailable');
  if (live.fence.missionId !== preflight.fence.missionId
    || live.fence.leaseId !== preflight.fence.leaseId
    || live.fence.generation !== preflight.fence.generation) {
    return deny('stale-fence', 'lease identity or fencing generation is no longer current');
  }
  if (live.fence.revision !== preflight.fence.revision) {
    return deny('revision-conflict', 'mission revision changed after preflight');
  }
  return {
    authorized: true,
    token: Object.freeze({
      effectId: preflight.effectId,
      capability: preflight.capability,
      authorizationRef: preflight.authorizationRef,
      missionId: live.fence.missionId,
      leaseId: live.fence.leaseId,
      generation: live.fence.generation,
      revision: live.fence.revision,
      resource: live.scope.resource,
    }),
  };
}

export const checkEffectPreflight = preflightEffect;
export const authorizeEffectBeforeUse = authorizeEffect;
