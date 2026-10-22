# ADR-406 M2 Native MissionService integration — candidate (19 October 2026)

## Scope / ownership
- Host: DESKTOP-A55K2JN.
- Isolated worktree: `D:\Users\NIKITA\Documents\DEV\worktrees\ruflo-native-m2-service-integration-20261019`.
- Branch: `native-m2-service-integration-20261019`; baseline: `574b98ef005dc61b6fab60fe19e9a82e937a196a`.
- GO Core V2 / Wave v2 were **not used**. No push, commit or modifications to dirty `ruflo-upstream` / existing M2 worktree.
- CrewSync CLI help invocation returned `invalid identity`; no CrewSync mutations and **no new SERVER_DONE** claimed.

## Candidate patch
- `v3/@claude-flow/cli/src/missions/service.ts`: trusted Native `executionAdmission` port on MissionContext.
- Admission/resume invoke existing `assessExecutionAdmission` within MissionStore control lock, after request dedup and revision fence; validate action and current durable Mission budget before recording event.
- Missing runtime authority remains `executor-unavailable`. The port is **not yet wired into stock CLI/MCP production factories**, so the installed stock CLI remains blocked.
- Admission event includes policy, budget, permission and evidence references, with dedicated `policyDecisionRef`.
- `v3/@claude-flow/cli/__tests__/missions/service-m2-admission.test.ts` covers default deny, authority proof, replay dedup, policy denial, ledger mismatch, and session-bound rejection.

## Fresh checks (local candidate, no independent QA)
- Focused `service.test.ts` + `service-m2-admission.test.ts`: **13/13 PASS** (Vitest v4.1.0).
- Focused plus `store-replay.test.ts`: **16 PASS / 1 FAIL**. Failure in subprocess fixture requires `@claude-flow/security` package linkage; this is an incomplete isolated test runtime, **not a clean test suite**.
- Full missions directory: **80 PASS / 1 FAIL / 1 failed suite** initially due missing `tsx` subprocess loader and `@claude-flow/cli-core/mcp-tools/types`; subsequent `tsx` installation exposes missing `@claude-flow/security`.
- Existing separate M2 worktree node test run: **67 PASS / 1 FAIL**. Failure `exact original-task worker-result schema, scope and source digest preflight`: a receipt SHA does not match its current source contents. Do not mutate those original receipts without owner reconciliation.
- `git diff --check`: no whitespace errors.

## Not yet proven / next step
- Trusted production admission proof authority and stock CLI/MCP factory wiring are **NOT DONE**.
- Real Codex PID/thread, independent QA, Native terminal, refill, crash/replay are **NOT DONE**.
- Next: connect trustworthy policy/budget/permission/read-only executor readiness into the existing MissionService port; test CLI/MCP symmetry with the real authorization source. Then compose the existing M2 dispatch journal, lease and Codex adapter for an isolated real Mission, without a second orchestrator.

## Reconciliation and BMad Quick Dev MVP critical path (2026-10-19)
- Fresh CrewSync coordinator inventory on A55 for non-superseded `ruflo-upstream-dev:m2-r7c/r8/r9` records: **21 OPEN, 3 DONE**. Older superseded tasks are excluded; the DONE records are bounded QA tasks and do **not** prove Native Mission E2E.
- Existing CrewSync records are retained. Readback-confirmed index note: `ruflo-upstream-dev:m2-native-mvp-critical-path-20261019`. This note is only a task-key/priority crosswalk, not an alternate DAG or source of execution authority.
- Seven outcome-oriented execution packages: (1) reconcile original tasks, owners, accepted SHA and source; (2) trusted MissionService admission + budget + CLI/MCP; (3) READY frontier + one-shot dispatch; (4) real official Codex binding + durable invocation journal; (5) source-bound tests/repair + independent QA and Native terminal; (6) real Native E2E and two consecutive automatic terminal→refill cycles; (7) crash/restart/replay with no duplicated terminal effects.
- Run each package via BMad Help → Quick Dev (existing spec and interface) → focused RED/GREEN tests → adversarial and independent QA → source SHA/receipts → authoritative CrewSync readback. Use existing task IDs and task-local write scopes; do not claim native acceptance from tests alone.
- Existing `D:/Users/NIKITA/Documents/DEV/ruflo/_bmad-output/implementation-artifacts/sprint-status.yaml` is dirty and primarily tracks a separate legacy Ruflo Factory epic. It was **not modified** as no verified safe writer ownership was established; do not silently create a competing sprint-status file.
- Fresh planning reconciliation only: no new Codex PID, physical Native E2E, QA_ACCEPT, or CrewSync SERVER_DONE is asserted here. GO Core V2/Wave v2 remain out of scope.

## Official Ruflo upstream audit (2026-10-19; read-only comparison)
- `git ls-remote https://github.com/ruvnet/ruflo.git refs/heads/main` returned `b93144803bb171b12993b715fe7b2dd936b6edd5` (commit timestamp 2026-10-18T01:47:54+01:00). A55 remote `upstream` correctly points to `https://github.com/ruvnet/ruflo.git` while `origin` points to `https://github.com/n0namer/ruflo.git`.
- Executed `git fetch --no-tags upstream main` successfully. This only advanced remote-tracking `upstream/main` from `72255a2f4` to `b93144803`; no checkout/reset of massively dirty `ruflo-upstream` (thousands of existing tracked deletions).
- New upstream commits: `git rev-list --count 72255a2f4..upstream/main` = **532**. Yet `git diff --quiet 72255a2f4 upstream/main -- v3/@claude-flow/cli/src/missions/` returned exit **0**, proving this production Mission subtree is unchanged since the old snapshot.
- `upstream/main:v3/@claude-flow/cli/src/missions/service.ts` still has hardcoded `requestAction(admit/resume) → executor-unavailable` (ADR-406 M2). `v3/@claude-flow/cli/scripts/e2e-adr-406.mjs` explicitly *asserts* this refusal; `src/mcp-tools/mission-tools.ts` documents it.
- Official Mission module has only `fold.ts, index.ts, observation.ts, schemas.ts, service.ts, store.ts, transitions.ts`. Our fork commit `574b98ef0` additionally adds `codex-executor.ts, execution-admission.ts, execution-frontier.ts, execution-lease.ts, execution-quality.ts, execution-recovery.ts`. `574b98ef0` is **not** an ancestor of `upstream/main`. Therefore upstream does not supply our M2 primitives.
- ADR-404 is **Accepted** (Claude Code mods); ADR-405 is **Proposed** (remote ruOS execution hosts); ADR-406 is **Proposed** (Mission control), M0/M1 are merged and M2 is not; ADR-407 is **Accepted** (Console cockpit). No ADR-402 or ADR-403 files or references were found in official v3 ADR index/files examined, and no implementation should be inferred.
- ADR-466 is **Accepted** (Console Mission Autopilot) but its design explicitly relies on a living Claude session plus `/loop`, and states a mod has no scheduler. This does not meet ADR-406 independent durable-executor M2 contract.
- New upstream Codex `v3/@claude-flow/codex/src/loop/index.ts` and `loop/cli.ts` provide a bounded Codex iteration loop (state files, stop marker, CLI), not the authoritative Mission/DAG admission/QA/terminal lifecycle. Upstream has newer Codex/security pins and a three-host E2E; these may be reusable after compatibility tests, but cannot be represented as Native Mission M2 acceptance.
- Decision: **do not replace or recreate our M2**. Finish minimal trusted integration in existing isolated branch; reuse upstream Codex adapter/safety fixes selectively after contract comparison. This audit did not run real M2/Codex E2E or independent QA, and creates no new SERVER_DONE.


