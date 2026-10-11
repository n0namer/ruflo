import { describe, expect, it } from 'vitest';
import {
  assessExecutionAdmission,
  isDangerousExecutionAction,
  type ExecutionAdmissionRequest,
} from '../../src/missions/execution-admission.js';

const baseRequest = (): ExecutionAdmissionRequest => ({
  action: 'run',
  worktree: {
    rooted: true,
    root: '/repo',
    candidate: '/repo',
    repositoryId: 'repo-1',
    sourceStateId: 'source-1',
  },
  policy: {
    allowed: true,
    decisionRef: 'policy-decision-1',
  },
  budget: {
    allowed: true,
    reservationRef: 'budget-reservation-1',
    estimatedMinor: 100,
    remainingMinor: 100,
  },
  permissions: {
    granted: true,
    required: ['fs.read'],
    explicit: ['fs.read'],
    authorizationRef: 'permission-1',
  },
  evidenceRefs: ['worktree-1', 'policy-1', 'budget-1', 'permission-1'],
});

describe('execution admission preflight', () => {
  it('admits only a fully evidenced, explicitly permitted safe execution', () => {
    const decision = assessExecutionAdmission(baseRequest());

    expect(decision).toEqual({
      admitted: true,
      code: 'admitted',
      evidenceRefs: baseRequest().evidenceRefs,
    });
  });

  it('denies an unrooted or mismatched worktree even when all other checks pass', () => {
    const request = { ...baseRequest(), worktree: { ...baseRequest().worktree, rooted: false } };

    const decision = assessExecutionAdmission(request);

    expect(decision.admitted).toBe(false);
    expect(decision.code).toBe('worktree-not-rooted');
  });

  it('denies policy that is not explicitly allowed and requires a decision reference', () => {
    const request = { ...baseRequest(), policy: { allowed: false, decisionRef: 'policy-decision-1' } };

    expect(assessExecutionAdmission(request).code).toBe('policy-denied');

    const missingReference = { ...baseRequest(), policy: { allowed: true } };
    expect(assessExecutionAdmission(missingReference).code).toBe('policy-evidence-missing');
  });

  it('denies budget overrun or missing reservation evidence', () => {
    const request = { ...baseRequest(), budget: { allowed: true, reservationRef: 'budget-1', estimatedMinor: 101, remainingMinor: 100 } };

    expect(assessExecutionAdmission(request).code).toBe('budget-exceeded');

    const missingReference = { ...baseRequest(), budget: { allowed: true, estimatedMinor: 0, remainingMinor: 100 } };
    expect(assessExecutionAdmission(missingReference).code).toBe('budget-evidence-missing');
  });

  it('requires every requested permission to be explicitly granted', () => {
    const request = {
      ...baseRequest(),
      permissions: {
        granted: true,
        required: ['fs.read', 'fs.write'],
        explicit: ['fs.read'],
        authorizationRef: 'permission-1',
      },
    };

    expect(assessExecutionAdmission(request).code).toBe('permission-missing');

    const denied = {
      ...baseRequest(),
      permissions: { granted: false, required: ['fs.read'], explicit: ['fs.read'], authorizationRef: 'permission-1' },
    };
    expect(assessExecutionAdmission(denied).code).toBe('permission-denied');
  });

  it('denies missing or empty evidence instead of silently authorizing', () => {
    const request = { ...baseRequest(), evidenceRefs: [] };

    expect(assessExecutionAdmission(request).code).toBe('evidence-missing');

    const duplicateEvidence = { ...baseRequest(), evidenceRefs: ['same', 'same', 'same', 'same'] };
    expect(assessExecutionAdmission(duplicateEvidence).code).toBe('evidence-missing');
  });

  it('requires absolute worktree paths and enforces the path boundary', () => {
    const relative = {
      ...baseRequest(),
      worktree: { ...baseRequest().worktree, root: 'repo', candidate: 'repo' },
    };
    expect(assessExecutionAdmission(relative).code).toBe('worktree-evidence-missing');

    const sibling = {
      ...baseRequest(),
      worktree: { ...baseRequest().worktree, candidate: '/repo-other' },
    };
    expect(assessExecutionAdmission(sibling).code).toBe('worktree-evidence-missing');

    const traversal = {
      ...baseRequest(),
      worktree: {
        ...baseRequest().worktree,
        root: 'D:/safe/repo',
        candidate: 'D:/safe/repo/../outside/secrets.ts',
      },
    };
    expect(assessExecutionAdmission(traversal).code).toBe('worktree-evidence-missing');

    const canonicalEscape = {
      ...baseRequest(),
      worktree: {
        ...baseRequest().worktree,
        canonicalRoot: '/real/repo',
        canonicalCandidate: '/real/outside/secrets.ts',
      },
    };
    expect(assessExecutionAdmission(canonicalEscape).code).toBe('worktree-evidence-missing');

    const canonicalSafe = {
      ...baseRequest(),
      worktree: {
        ...baseRequest().worktree,
        canonicalRoot: '/real/repo',
        canonicalCandidate: '/real/repo/subdir',
      },
    };
    expect(assessExecutionAdmission(canonicalSafe).code).toBe('admitted');
  });

  it('rejects dangerous send/push actions regardless of ordinary permission grants', () => {
    for (const action of [
      'send',
      'push',
      'git push',
      'publish',
      'deploy',
      'sendMessage',
      'pushChanges',
      'publishArtifact',
      'deployNow',
    ]) {
      const request = { ...baseRequest(), action };
      const decision = assessExecutionAdmission(request);

      expect(isDangerousExecutionAction(action)).toBe(true);
      expect(decision.admitted).toBe(false);
      expect(decision.code).toBe('dangerous-action');
    }

    const safeEdit = { ...baseRequest(), action: 'editFile' };
    expect(isDangerousExecutionAction(safeEdit.action)).toBe(false);
    expect(assessExecutionAdmission(safeEdit).code).toBe('admitted');
  });

  it('does not treat a successful process exit code as authorization or evidence', () => {
    const request = {
      ...baseRequest(),
      policy: { allowed: false, decisionRef: undefined, exitCode: 0 },
      exitCode: 0,
    };

    const decision = assessExecutionAdmission(request);

    expect(decision.admitted).toBe(false);
    expect(decision.code).toBe('policy-denied');
  });
});
