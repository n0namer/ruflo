# ADR-406 M2 — once-only Codex dispatch composition (isolated candidate)

Date: 2026-10-15. Source HEAD: `574b98ef0`. Scope: isolated worktree `D:/Users/NIKITA/Documents/DEV/worktrees/ruflo-upstream-m2-once-20261015`.

This is **not** a new DAG, scheduler, CrewSync client, or Codex launcher. It composes two existing **candidate, currently untracked in the main upstream checkout** primitives:
- `execution-invocation-journal.ts`, an atomic per-mission invocation status journal;
- `execution-dispatch-binding.ts`, binding an authenticated invocation, lease/epoch and actual Codex receipt.

Their source bytes were copied without edits from the dirty upstream checkout into this isolated worktree. The SHA-256 checks returned exact source/destination matches. The only newly authored executable component is `src/missions/execution-once-dispatch.ts` and its test `__tests__/missions/execution-once-dispatch.test.mjs`.

## Safety contract

1. Fail closed when the invocation and credential differ from the trusted intent, or the prompt hash mismatches `inputDigest`.
2. Use the existing journal's atomic `prepare` and `markDispatched` with a fresh dispatchRef. **Only the winning caller** may call the existing bound Codex executor.
3. A repeated invocation returns `previously-dispatched` without starting a worker. A lost journal response or physical dispatch exception stays **unresolved** and cannot be blindly retried.
4. The returned receipt is **observed, not accepted**. Terminal Mission events, independent QA, budget settlement and recovery reconciliation remain exclusively with the stock runtime.
5. No user-facing real Codex process was started by these tests, and no production Mission store or foreign workspace was mutated.

## Verification

- `node --experimental-strip-types --test v3/@claude-flow/cli/__tests__/missions/execution-once-dispatch.test.mjs` — **8 tests PASS, 0 fail**, including 24 concurrent duplicate callers, replay, malformed identity, lost journal/worker acknowledgement and no self-acceptance.
- `tsc --noEmit ... execution-once-dispatch.ts` — **BLOCKED by pre-existing transitive upstream diagnostics** in `transitions.ts:113` and `policy-ledger-anchor.ts:135,140,146`. No diagnostic points at the newly authored once-dispatch module.
- Clean HEAD lacks the candidate journal and dispatch files; they are untracked in the original upstream. They must be independently reviewed and integrated before this patch can be considered upstream-ready.
- No independent integration test with the actual durable journal, physical Codex spawn, M2 admission, QA or terminal transition yet. This is a narrowly scoped **candidate only**.

## Next smallest integration

Once the existing M2 owner merges/reconciles the untracked primitives and upstream source-level changes, call `dispatchOnce` from the **admitted official Mission executor path** with a trusted `InvocationIntent`. Prove two independent processes racing the same invocation ID result in **at most one** physical Codex `thread.started`, then validate restart/unknown-receipt reconciliation and independent QA. Do not register a new CLI/queue or relax native policy.
