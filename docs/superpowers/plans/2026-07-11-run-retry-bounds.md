# Run Retry Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound non-quota retries for non-interactive `opencode run` to five retries and 120 seconds without changing global retry behavior.

**Architecture:** Keep enforcement in `src/cli/cmd/run.ts`, where the CLI consumes `session.status.retry` and can abort a Session. Quota errors retain immediate abort and key rotation; other retry statuses use `attempt` and `next` for CLI-only bounds.

**Tech Stack:** TypeScript, Bun test, Effect, OpenCode SDK v2.

## Global Constraints

- Apply retry bounds only to non-interactive `opencode run`; do not modify `SessionRetry.policy`.
- Known quota errors abort immediately and remain eligible for key rotation.
- Non-quota errors never rotate keys or write `throttle.json`.
- Allow attempts 1 through 5; reject attempt 6 before it waits.
- Abort a non-quota retry when `status.next` would exceed 120 seconds from retry attempt 1.
- Text and JSON retry-bound errors use `OPENCODE_RETRY_LIMIT:`.
- Run tests and `bun typecheck` from `packages/opencode`.

---

### Task 1: Add retry-limit process regressions

**Files:**
- Modify: `packages/opencode/test/cli/run/run-process-limit.test.ts`

**Interfaces:**
- Consumes: `opencode.run(message, { format?, timeoutMs? })` and TestLLMServer response helpers.
- Produces: process assertions for retry count, retry deadline, text output, and JSON output.

- [ ] **Step 1: Write failing retry-count tests**

Queue five retryable 500 responses followed by text and assert exit code `0`. Queue six retryable 500 responses and assert nonzero exit, duration below 30 seconds, and `OPENCODE_RETRY_LIMIT:` in stderr. Set `retry-after-ms: 0` so the suite does not sleep.

```ts
const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
expect(result.exitCode).not.toBe(0)
expect(result.stderr).toContain("OPENCODE_RETRY_LIMIT:")
expect(result.durationMs).toBeLessThan(30_000)
```

- [ ] **Step 2: Write failing deadline and JSON tests**

Return a retryable response with `retry-after: 121` and assert immediate nonzero exit with `OPENCODE_RETRY_LIMIT:`. Add a JSON-format sixth-failure test that requires a prefixed `error.message` while retaining retry fields.

```ts
const events = opencode.parseJsonEvents(result.stdout)
expect(events.find((event) => event.type === "error")?.error).toMatchObject({
  type: "retry",
  message: expect.stringMatching(/^OPENCODE_RETRY_LIMIT:/),
  attempt: expect.any(Number),
  next: expect.any(Number),
})
```

- [ ] **Step 3: Run tests and confirm red**

Run:

```sh
bun test --test-name-pattern 'retry limit|Retry-After|format json' test/cli/run/run-process-limit.test.ts --timeout 60000
```

Expected: new marker and bounded-retry assertions fail because no retry-limit path exists.

### Task 2: Bound CLI retry status handling

**Files:**
- Modify: `packages/opencode/src/cli/cmd/run.ts:35-55`
- Modify: `packages/opencode/src/cli/cmd/run.ts:827-850`

**Interfaces:**
- Consumes: retry status `{ attempt, message, next }`, `SessionRetry.isQuotaOrRateLimitRetryStatus`, and `client.session.abort({ sessionID })`.
- Produces: `OPENCODE_RETRY_LIMIT` text/JSON errors and bounded non-quota retries.

- [ ] **Step 1: Add CLI-only constants and message helper**

Add constants beside `quotaError` and use the existing error-payload pattern for both markers.

```ts
const RUN_RETRY_MAX_ATTEMPTS = 5
const RUN_RETRY_MAX_WAIT = 120_000

function retryLimitError(message: string) {
  return `OPENCODE_RETRY_LIMIT: ${message}`
}
```

- [ ] **Step 2: Track a non-quota retry deadline**

Before `loop`, declare `let retryDeadline: number | undefined`. In a non-quota retry branch, reset it when `status.attempt === 1` to `Date.now() + RUN_RETRY_MAX_WAIT`. Abort before waiting when either condition is true:

```ts
status.attempt > RUN_RETRY_MAX_ATTEMPTS || status.next > retryDeadline
```

On the limit, abort the session, produce `retryLimitError(status.message)`, emit the prefixed JSON error in JSON mode, print the same text in default mode, and return from the event loop.

- [ ] **Step 3: Preserve quota ordering**

Keep recognized quota handling before generic retry limiting. Do not set `pendingRotation` for generic retry-limit errors.

```ts
if (status.type === "retry" && SessionRetry.isQuotaOrRateLimitRetryStatus(status)) {
  // Existing abort, immediate exit, and key rotation path.
}
```

- [ ] **Step 4: Run focused tests and confirm green**

Run:

```sh
bun test --test-name-pattern 'retry limit|Retry-After|format json' test/cli/run/run-process-limit.test.ts --timeout 60000
```

Expected: all new retry-limit tests pass.

### Task 3: Verify quota and rotation contracts

**Files:**
- Verify: `packages/opencode/test/session/retry.test.ts`
- Verify: `packages/opencode/test/cli/run/run-process-limit.test.ts`
- Verify: `packages/opencode/test/cli/run/run-key-rotation.test.ts`

**Interfaces:**
- Consumes: existing quota classification, process, and key-rotation fixtures.
- Produces: evidence that retry limits do not change quota exits or API-key rotation.

- [ ] **Step 1: Run regression suites**

Run:

```sh
bun test test/session/retry.test.ts --timeout 30000
bun test test/cli/run/run-process-limit.test.ts --timeout 60000
bun test test/cli/run/run-key-rotation.test.ts --timeout 60000
```

Expected: all tests pass, including quota exits, JSON quota markers, rotation, all-key exhaustion, and throttle-disabled rotation.

- [ ] **Step 2: Format and typecheck**

Run:

```sh
bunx prettier --write src/cli/cmd/run.ts test/cli/run/run-process-limit.test.ts
bun typecheck
git diff --check
```

Expected: typecheck succeeds and whitespace check is clean.

- [ ] **Step 3: Build and release verification**

Run:

```sh
bun run script/build.ts --single --skip-install --skip-embed-web-ui
PATH=/tmp/opencode-verify:$PATH timeout --signal=TERM 25s /usr/sbin/opencode-cheap run 'hi'
PATH=/tmp/opencode-verify:$PATH timeout --signal=TERM 25s /usr/sbin/opencode-cheap run --format json 'hi'
```

Expected: both commands return nonzero before timeout; text and JSON expose `OPENCODE_QUOTA_LIMIT:`.

- [ ] **Step 4: Commit implementation**

Run:

```sh
git add packages/opencode/src/cli/cmd/run.ts packages/opencode/test/cli/run/run-process-limit.test.ts
git commit -s -S -m 'fix(cli): bound run retries'
```

Expected: one signed commit containing only retry-limit implementation and tests.
