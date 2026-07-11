// Provider quota/rate-limit behavior for `opencode run` (non-interactive mode).
// Kept separate from run-process.test.ts so these subprocess cases do not
// compete with the main CLI regression suite under turbo's full test load.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode run provider limits (non-interactive subprocess)", () => {
  cliIt.live(
    "exits nonzero promptly when the provider reports a quota limit",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, {
          type: "error",
          error: {
            type: "FreeUsageLimitError",
            message: "Free usage exceeded",
          },
        })
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT: Free usage exceeded")
      }),
    45_000,
  )

  cliIt.live(
    "exits nonzero promptly when the provider reports a rate limit",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT:")
      }),
    45_000,
  )

  cliIt.live(
    "exits nonzero promptly when the provider reports a zen RateLimitError",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, {
          type: "error",
          error: {
            type: "RateLimitError",
            message: "Rate limit exceeded. Please try again later.",
          },
        })
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT: Rate limit exceeded. Please try again later.")
      }),
    45_000,
  )

  cliIt.live(
    "exits nonzero promptly when the provider reports a zen BlackUsageLimitError",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, {
          type: "error",
          error: {
            type: "BlackUsageLimitError",
            message: "Subscription quota exceeded. Retry in 5min.",
          },
        })
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT: Subscription quota exceeded. Retry in 5min.")
      }),
    45_000,
  )

  cliIt.live(
    "exits nonzero promptly when the provider reports a zen GoUsageLimitError",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, {
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_test",
            limitName: "weekly",
          },
        })
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT:")
      }),
    45_000,
  )

  cliIt.live(
    "continues waiting through non-limit retryable provider errors",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(500, { type: "error", error: { type: "server_error", message: "temporary failure" } })
        yield* llm.text("after retry")
        const result = yield* opencode.run("say hi", { timeoutMs: 30_000 })
        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("after retry\n")
      }),
    45_000,
  )

  cliIt.live(
    "--format json emits an error and exits nonzero for provider limit retries",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        const result = yield* opencode.run("say hi", { format: "json", timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toBe("")
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toContain("error")
        expect(events.find((event) => event.type === "error")?.error).toMatchObject({
          message: expect.stringMatching(/^OPENCODE_QUOTA_LIMIT:/),
        })
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    45_000,
  )
})
