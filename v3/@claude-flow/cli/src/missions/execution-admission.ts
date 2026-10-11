/**
 * Stock Ruflo M2 execution-admission preflight.
 *
 * This is deliberately a pure gate: callers must supply independently produced
 * worktree, policy, budget, permission, and evidence facts. No process result,
 * exit code, caller assertion, or default is treated as authorization.
 */

export interface WorktreeAdmissionEvidence {
  readonly rooted: boolean;
  readonly root: string;
  readonly candidate: string;
  readonly repositoryId: string;
  readonly sourceStateId: string;
  /**
   * Optional canonical paths supplied by the trusted Native admission caller.
   * This pure gate does not resolve symlinks or authenticate these values.
   */
  readonly canonicalRoot?: string;
  readonly canonicalCandidate?: string;
}

export interface PolicyAdmissionEvidence {
  readonly allowed: boolean;
  readonly decisionRef?: string;
}

export interface BudgetAdmissionEvidence {
  readonly allowed: boolean;
  readonly reservationRef?: string;
  readonly estimatedMinor: number;
  readonly remainingMinor: number;
}

export interface PermissionAdmissionEvidence {
  readonly granted: boolean;
  readonly required: readonly string[];
  readonly explicit: readonly string[];
  readonly authorizationRef?: string;
}

export interface ExecutionAdmissionRequest {
  readonly action: string;
  readonly worktree: WorktreeAdmissionEvidence;
  readonly policy: PolicyAdmissionEvidence;
  readonly budget: BudgetAdmissionEvidence;
  readonly permissions: PermissionAdmissionEvidence;
  /** References to the independent receipts supporting this preflight. */
  readonly evidenceRefs: readonly string[];
  /** Accepted for compatibility only; never inspected as authority. */
  readonly exitCode?: number;
}

export type ExecutionAdmissionCode =
  | 'admitted'
  | 'invalid-input'
  | 'dangerous-action'
  | 'worktree-not-rooted'
  | 'worktree-evidence-missing'
  | 'policy-denied'
  | 'policy-evidence-missing'
  | 'budget-denied'
  | 'budget-evidence-missing'
  | 'budget-exceeded'
  | 'permission-denied'
  | 'permission-missing'
  | 'permission-evidence-missing'
  | 'evidence-missing';

export type ExecutionAdmissionDecision =
  | {
      readonly admitted: true;
      readonly code: 'admitted';
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly admitted: false;
      readonly code: Exclude<ExecutionAdmissionCode, 'admitted'>;
      readonly reason: string;
    };

const DANGEROUS_ACTION = /(?:^|[\s:_-])(send|push|publish|deploy|release)(?:$|[\s:_-])/i;
const DANGEROUS_CAMELCASE_ACTION = /(send|push|publish|deploy|release)(?=[A-Z])/;

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAction(action: unknown): string {
  return typeof action === 'string' ? action.trim() : '';
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    || (value.length >= 3 && /^[A-Za-z]:$/.test(value.slice(0, 2)) && value[2] === '/');
}

function normalizePath(value: string): string {
  const slash = String.fromCharCode(92);
  let normalized = value.split(slash).join('/');
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function hasTraversalSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..');
}

function withinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  if (
    !isAbsolutePath(normalizedRoot)
    || !isAbsolutePath(normalizedCandidate)
    || hasTraversalSegment(normalizedRoot)
    || hasTraversalSegment(normalizedCandidate)
  ) return false;
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + '/');
}

function deny(code: Exclude<ExecutionAdmissionCode, 'admitted'>, reason: string): ExecutionAdmissionDecision {
  return { admitted: false, code, reason };
}

/** True for actions that can send data or change external/release state. */
export function isDangerousExecutionAction(action: string): boolean {
  const normalized = normalizeAction(action);
  return DANGEROUS_ACTION.test(normalized) || DANGEROUS_CAMELCASE_ACTION.test(normalized);
}

/**
 * Check M2 admission preconditions without performing execution or mutation.
 * The first failed gate is returned so callers can receipt the exact denial.
 */
export function assessExecutionAdmission(input: ExecutionAdmissionRequest): ExecutionAdmissionDecision {
  if (!input || typeof input !== 'object') return deny('invalid-input', 'admission request is required');

  const action = normalizeAction(input.action);
  if (!action) return deny('invalid-input', 'action is required');
  if (isDangerousExecutionAction(action)) {
    return deny('dangerous-action', 'send/push/publish/deploy actions are outside this preflight');
  }

  const worktree = input.worktree;
  if (!worktree || worktree.rooted !== true) {
    return deny('worktree-not-rooted', 'a rooted worktree is required');
  }
  if (
    !present(worktree.root)
    || !present(worktree.candidate)
    || !withinRoot(worktree.root, worktree.candidate)
    || !present(worktree.repositoryId)
    || !present(worktree.sourceStateId)
  ) {
    return deny('worktree-evidence-missing', 'root, candidate, repository and source-state evidence are required');
  }
  // Physical realpath/symlink checks and independent attestation belong to the
  // trusted Native caller; this pure gate only rejects unsafe lexical paths.
  if (
    (worktree.canonicalRoot !== undefined) !== (worktree.canonicalCandidate !== undefined)
    || (worktree.canonicalRoot !== undefined
      && (!present(worktree.canonicalRoot)
        || !present(worktree.canonicalCandidate)
        || !withinRoot(worktree.canonicalRoot, worktree.canonicalCandidate)))
  ) {
    return deny('worktree-evidence-missing', 'canonical worktree evidence must be complete and rooted');
  }

  const policy = input.policy;
  if (!policy || policy.allowed !== true) {
    return deny('policy-denied', 'policy did not explicitly allow this execution');
  }
  if (!present(policy.decisionRef)) {
    return deny('policy-evidence-missing', 'policy decision evidence is required');
  }

  const budget = input.budget;
  if (!budget || budget.allowed !== true) {
    return deny('budget-denied', 'budget did not explicitly allow this execution');
  }
  if (!present(budget.reservationRef)) {
    return deny('budget-evidence-missing', 'budget reservation evidence is required');
  }
  if (
    !Number.isSafeInteger(budget.estimatedMinor)
    || budget.estimatedMinor < 0
    || !Number.isSafeInteger(budget.remainingMinor)
    || budget.remainingMinor < 0
  ) {
    return deny('budget-evidence-missing', 'budget amounts must be safe non-negative integers');
  }
  if (budget.estimatedMinor > budget.remainingMinor) {
    return deny('budget-exceeded', 'estimated cost exceeds the remaining budget');
  }

  const permissions = input.permissions;
  if (!permissions || permissions.granted !== true) {
    return deny('permission-denied', 'explicit permission grant is required');
  }
  if (!present(permissions.authorizationRef)) {
    return deny('permission-evidence-missing', 'permission authorization evidence is required');
  }
  if (!Array.isArray(permissions.required) || !Array.isArray(permissions.explicit)) {
    return deny('permission-evidence-missing', 'required and explicit permission lists are required');
  }
  if (
    permissions.required.some((permission) => !present(permission))
    || permissions.explicit.some((permission) => !present(permission))
  ) {
    return deny('permission-evidence-missing', 'permission names must be non-empty strings');
  }
  const explicit = new Set(permissions.explicit);
  if (permissions.required.some((permission) => !explicit.has(permission))) {
    return deny('permission-missing', 'every required permission must be explicitly granted');
  }

  if (
    !Array.isArray(input.evidenceRefs)
    || input.evidenceRefs.length < 4
    || input.evidenceRefs.some((ref) => !present(ref))
    || new Set(input.evidenceRefs).size < 4
  ) {
    return deny('evidence-missing', 'four distinct worktree, policy, budget and permission evidence references are required');
  }

  return { admitted: true, code: 'admitted', evidenceRefs: [...input.evidenceRefs] };
}

/** Descriptive aliases for callers that prefer preflight/check naming. */
export const preflightExecutionAdmission = assessExecutionAdmission;
export const checkExecutionAdmission = assessExecutionAdmission;
