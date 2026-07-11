# Single-Key Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and honor quota throttle records when `OPENCODE_API_KEY` contains one key.

**Architecture:** Route every non-empty `OPENCODE_API_KEY` list through `runWithKeyRotation`, including one key. `KeyRotator` remains the shared throttle reader and writer. A quota failure records the key before the controller reports exhaustion; a later CLI invocation sees the same record and exits before contacting the provider.

**Tech Stack:** TypeScript, Bun test, Effect subprocess CLI tests.

## Global Constraints

- Keep `OPENCODE_THROTTLE_ENABLE=false` as a complete read/write opt-out.
- Do not change quota detection, API-key parsing, or retry policy.
- Preserve final quota error and nonzero exit for a throttled single key.

---

### Task 1: Cover single-key shared throttle behavior

**Files:**

- Modify: `packages/opencode/test/cli/run/run-key-rotation.test.ts:194-215`

**Interfaces:**

- Consumes: `opencode.run(prompt, { env, timeoutMs })` and per-test `home` directory.
- Produces: subprocess regression proving persisted record suppresses later invocation.

- [ ] **Step 1: Replace obsolete assertion with failing shared-state test**

Replace existing single-key test with test named `single key writes throttle.json and later invocation skips it after quota limit`. It must run key1 against 429 `RateLimitError`, assert nonzero exit, read `throttle.json`, assert an `OPENCODE_API_KEY` record matching `hashKey("key1")`, then run same command again with same `home` and assert nonzero exit plus `OPENCODE_QUOTA_LIMIT: all configured API keys are exhausted or throttled`.

- [ ] **Step 2: Run test and confirm RED state**

Run: `bun test test/cli/run/run-key-rotation.test.ts --timeout 60000`

Expected: new test fails at reading `throttle.json` with `ENOENT`.

### Task 2: Route one key through shared throttle control

**Files:**

- Modify: `packages/opencode/src/cli/cmd/run/key-rotation.ts:12-17`
- Test: `packages/opencode/test/cli/run/run-key-rotation.test.ts`

**Interfaces:**

- Consumes: `parseKeys(): string[]`, `KeyRotator.selectKey()`, and `KeyRotator.recordThrottle(key)`.
- Produces: quota persistence for any non-empty explicit key list.

- [ ] **Step 1: Change only no-explicit-key fast path**

Replace `if (keys.length <= 1)` with:

```ts
if (keys.length === 0) {
  await options.execute(options.createSdk())
  return
}
```

Existing quota handling already calls `await rotator.recordThrottle(key)` before final exhaustion, so a one-key quota then writes the shared record.

- [ ] **Step 2: Run regression and confirm GREEN state**

Run: `bun test test/cli/run/run-key-rotation.test.ts --timeout 60000`

Expected: all key-rotation subprocess tests pass.

- [ ] **Step 3: Run focused verification**

Run: `bun test test/provider/key-rotator.test.ts --timeout 30000 && bun test test/provider/throttle-store.test.ts --timeout 30000 && bun typecheck && git diff --check`

Expected: all commands exit 0.

- [ ] **Step 4: Commit implementation**

Run: `git add packages/opencode/src/cli/cmd/run/key-rotation.ts packages/opencode/test/cli/run/run-key-rotation.test.ts && git commit -s -S -m "fix(opencode): persist single key throttle"`
