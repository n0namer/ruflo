/**
 * ADR-406 M2: translate real Ruflo policy receipts into the existing
 * MissionService admission contract. No second store, runner or permission
 * source. This is deliberately NOT automatically enabled by CLI/MCP.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import {
  evaluatePolicyRequest, loadPolicyState, verifyPolicyLedger,
} from '../services/policy-runtime.js';
import type { NativeMissionHost } from './native-runtime-host.js';
import type { MissionView } from './transitions.js';
import type { ExecutionAdmissionRequest } from './execution-admission.js';

const sha = (value: string): string =>
  'sha256:' + createHash('sha256').update(value).digest('hex');

const samePath = (left: string, right: string): boolean =>
  left.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() ===
  right.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

function cleanGitRoot(root: string): { repositoryId: string; sourceId: string } | null {
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (!samePath(realpathSync(git('rev-parse', '--show-toplevel')), root)) return null;
    const head = git('rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(head)) return null;
    // Mission/policy state belongs to the stock Ruflo .claude-flow directory.
    // Other uncommitted files cannot be treated as a stable source snapshot.
    const changes = git('status', '--porcelain=v1', '--untracked-files=all').split(/\r?\n/)
      .map(s => s.trim()).filter(Boolean);
    if (changes.some(line => !/^\?\? \.claude-flow\//.test(line))) return null;
    return { repositoryId: sha(root), sourceId: sha(head) };
  } catch {
    return null;
  }
}

export interface NativePolicyHostOptions {
  /** Trusted and fenced executor health, not a user-supplied CLI/MCP flag. */
  readonly durableExecutorReady: () => boolean;
}

/**
 * Fail-closed local proof. Requires operator-configured ENFORCE policy rules
 * for mission.execute AND each capability; no implicit legacy/observe grants.
 * Monetary reservation itself is made atomically by MissionStore's
 * admission.accepted transition, not duplicated here.
 */
export function createNativePolicyHost(projectRoot: string, options: NativePolicyHostOptions): NativeMissionHost {
  const root = realpathSync(resolve(projectRoot));
  const expectedWorkspaceId = 'ws_' + createHash('sha256').update(root).digest('hex').slice(0, 16);
  const expectedPrincipalId = 'local:' + userInfo().username;
  return {
    durableExecutorReady: options.durableExecutorReady,
    async executionAdmission(view: MissionView, action: 'admit' | 'resume'): Promise<ExecutionAdmissionRequest | null> {
      // This host is bound to one verified owner and workspace; no cross-project grants.
      if (view.record.tenantId !== 'local' || view.record.workspaceId !== expectedWorkspaceId ||
          view.record.ownerPrincipalId !== expectedPrincipalId) return null;
      // Resume needs checkpoint-specific reauthorization; do not guess.
      if (action !== 'admit' || !options.durableExecutorReady()) return null;
      if (view.record.executionMode !== 'durable-executor' || !view.planBody || !view.budget) return null;
      try {
        const source = cleanGitRoot(root);
        if (!source || loadPolicyState(root).mode !== 'enforce') return null;
        const remaining = view.budget.ceilingMinor - view.budget.reservedMinor -
          view.budget.settledMinor - view.budget.unresolvedMinor;
        if (remaining < view.budget.estimatedMinor || view.budget.estimatedMinor < 0) return null;
        const capabilities = [...new Set([
          ...view.planBody.scope.capabilities,
          ...view.planBody.tasks.flatMap(task => task.capabilityCeiling),
        ])];
        const actions = ['mission.execute', ...capabilities.map(cap => 'mission.capability.' + cap)];
        const policyReceipts: string[] = [];
        for (const type of actions) {
          const decision = await evaluatePolicyRequest({
            identity: { id: 'local:' + userInfo().username, type: 'user' },
            action: { type, resource: root },
            context: { metadata: {
              missionId: view.record.missionId,
              planDigest: view.record.plan.digest,
              revision: view.record.revision,
              sourceStateId: source.sourceId,
            } },
          }, root);
          if (decision.mode !== 'enforce' || decision.outcome !== 'allowed' ||
              decision.enforcedOutcome !== 'allowed' || !decision.receiptId ||
              decision.matchedRules.length === 0) return null;
          policyReceipts.push(decision.receiptId);
        }
        if (!(await verifyPolicyLedger(root)).valid || loadPolicyState(root).mode !== 'enforce') return null;
        const approvalRef = 'policy-grants:' + sha(policyReceipts.join(':'));
        const reservationRef = 'mission-ledger-reservation:' +
          sha(view.record.missionId + ':' + view.record.revision + ':' + view.record.plan.digest);
        const canonical = root.replaceAll('\\', '/');
        return {
          action,
          worktree: { rooted: true, root: canonical, candidate: canonical,
            canonicalRoot: canonical, canonicalCandidate: canonical,
            repositoryId: source.repositoryId, sourceStateId: source.sourceId },
          policy: { allowed: true, decisionRef: policyReceipts[0] },
          budget: { allowed: true, reservationRef, remainingMinor: remaining,
            estimatedMinor: view.budget.estimatedMinor },
          permissions: { granted: true, required: capabilities, explicit: capabilities,
            authorizationRef: approvalRef },
          evidenceRefs: ['worktree:' + source.sourceId,
            'policy:' + policyReceipts[0], 'budget:' + reservationRef, 'permission:' + approvalRef],
        };
      } catch {
        return null;
      }
    },
  };
}
