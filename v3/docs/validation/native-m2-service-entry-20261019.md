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

## Upstream rebase and working candidate (A55; later 2026-10-19)
- Remote `git ls-remote upstream refs/heads/main` had advanced again to **`6cdad1ae0e4123a307a257b06d4a89b3962f1a53`** (2026-10-19). `git fetch --no-tags upstream main` succeeded. Official `main` is not the local fork `origin`.
- NEW OWNED isolated sparse worktree: `D:/Users/NIKITA/Documents/DEV/worktrees/ruflo-native-m2-upstream-20261019`, branch `native-m2-upstream-20261019`, base `6cdad1ae0`. The pre-existing dirty checkout, old detached M2 worktree and `native-m2-service-integration-20261019` branch were left unchanged.
- Cherry-picked existing M2 primitive commit `574b98ef0` with no conflicts as **`2c63898ef`** (12 files). Copied the existing uncommitted trusted-entry candidate `service.ts` and its `service-m2-admission.test.ts` plus evidence from the separate integration worktree, without editing the source worktree.
- Reused unchanged `execution-once-dispatch.ts`, `execution-dispatch-binding.ts`, `execution-invocation-journal.ts`, and `execution-once-dispatch.test.mjs` from the old detached M2 worktree. These were untracked in that worktree; the copied files are a **candidate**, not an independently accepted M2 implementation.
- Existing linked test toolchain via a local `node_modules` junction (test dependency reuse, not product runtime). Focused Vitest with official CLI-local `vitest.config.ts`: `service.test.ts` + `service-m2-admission.test.ts` + `execution-admission.test.ts` = **22/22 PASS, exit 0**.
- Full `__tests__/missions/`: **80 PASS / 1 FAIL / 1 failed-to-load suite**. `store-replay.test.ts` subprocess cannot resolve `@claude-flow/security` source package (missing built package linkage), and `adapters.test.ts` cannot resolve `@claude-flow/cli-core/mcp-tools/types` under partial workspace setup. Not a GREEN full-suite claim.
- Reused once-dispatch deterministic test: `node --experimental-strip-types --test __tests__/missions/execution-once-dispatch.test.mjs` = **8/8 PASS, exit 0**; verifies replay denied, 24 concurrent callers only one physical-dispatch *mock*, unknown outcome fail-closed.
- This branch has NOT installed/replaced system-wide Ruflo CLI, not enabled a production executor, and not run real Codex. No new independent QA, Native terminal or CrewSync SERVER_DONE. Current P0 integration boundary remains **genuine policy/permission/budget authority → common CLI/MCP trusted admission factory → durable dispatch + Codex**.
- Device space constrained: D: under 1 GiB free, so sparse worktree and existing test dependencies were used instead of a full npm installation. Keep all other worktrees intact.

## Async admission transaction fix — 2026-10-19 (CANDIDATE)
- Extended the **existing** MissionStore.withMission writer callback to await an asynchronous result under the same durable per-Mission lock. MissionService.control checks prior request ID and expected revision **before** invoking the async trusted callback; event append/replay retains the same fencing transaction.
- Root-caused an intermittent deterministic hang in cancel: transition decisions used a function field named `then`; returning that object from an async function triggered JavaScript Promise/thenable assimilation. Renamed the internal follow-on callback to `followUp`; no external API or event format changed.
- Native host now rejects admission if de-registered or not ready **either before or after** awaiting its evidence callback, protecting revocation during the asynchronous check.
- Fresh checked command (CLI-local Vitest config): `node ../../../node_modules/vitest/vitest.mjs run __tests__/missions/native-runtime-host.test.ts __tests__/missions/adapters.test.ts __tests__/missions/service.test.ts __tests__/missions/service-m2-admission.test.ts __tests__/missions/execution-admission.test.ts --testTimeout 12000`: **35 PASS / 0 FAIL; exit 0**.
- Negative tests cover async denial retaining revision 2 and budget reserved=0, 2 concurrent requests only one admission, duplicate ID idempotence, cancel settlement, and host revocation during awaited authority check.
- This does **not** instantiate real policy authority or provide genuine Codex PID/thread. Installed Ruflo and production mode remain unchanged; no QA_ACCEPT or CrewSync SERVER_DONE claimed. Next critical task: trusted authenticated policy/permission + atomic budget reservation provider and production CLI/MCP bootstrap, followed by physical Codex canary.

## Real Ruflo policy-backed M2 admission — 2026-10-19 (CANDIDATE)
- Added a narrowly scoped adapter `native-policy-admission.ts` using existing `loadPolicyState`, `evaluatePolicyRequest`, and `verifyPolicyLedger`. No competing policy engine, task store, planner or Codex runner.
- The host is explicitly installed only by trusted program code, never a CLI/MCP request or environment toggle. It is pinned to OS principal, tenant, canonical Git root and authoritative workspace ID. Only a clean source snapshot with real Git HEAD is considered admissible.
- Requires policy mode `enforce` and verified **allow** receipts for `mission.execute` and every Mission capability. `legacy` and `observe` grant nothing. Ruflo MissionStore alone performs the atomic Mission-specific budget reservation in `admission.accepted`; the adapter does not claim external provider charges are already settled.
- Refuses `resume` until verified checkpoint recovery is wired, and refuses an unready durable executor. No startup autowiring is implemented; the installed Ruflo CLI remains fail-closed without a registered host.
- Test uses actual Ruflo policy ledger and rules in an isolated temporary Git repository (not a synthetic always-allow callback). Fresh check: **40/40 PASS**, 0 FAIL; six Vitest suites for policy, Native host, CLI/MCP, service, admission. All are unit/integration tests; NO physical Codex or independent Native E2E acceptance.
- Follow-up required for MVP: bind trusted resident executor readiness, verify provider budget/spend reservations and final authority fence, then one real physical Codex dispatch and independent QA/terminal/refill. No new CrewSync SERVER_DONE.
