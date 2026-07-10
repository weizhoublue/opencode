// Key rotation behavior for `opencode run` (non-interactive subprocess).
// Kept in a separate file to avoid competing with the main CLI regression suite.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

beforeEach(() => {
  delete process.env.OPENCODE_API_KEY
})

afterEach(() => {
  delete process.env.OPENCODE_API_KEY
})

describe("opencode run key rotation (non-interactive subprocess)", () => {
  cliIt.live(
    "uses key2 when throttle.json marks key1 as throttled at startup",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        // Pre-seed throttle.json: key1 is throttled
        const now = Date.now()
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key: "key1",
                startTime: now - 1000,
                endTime: now + 7_200_000, // 2 hours from now
              },
            ]),
          ),
        )

        // LLM mock: returns success for any key (key2 will be used)
        yield* llm.success("hello from key2")

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 30_000,
        })
        expect(result.exitCode).toBe(0)
        // key2 was used (key1 skipped due to throttle.json pre-check)
      }),
    45_000,
  )

  cliIt.live(
    "falls back to key2 and writes throttle.json when key1 returns 429",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        // key1: 429, key2: success
        yield* llm.errorForKey("key1", 429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })
        yield* llm.success("hello from key2")

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 40_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain("KeyRotationRetry")
        expect(result.stderr).not.toContain("/$bunfs/")

        // throttle.json should now have key1
        const data = JSON.parse(yield* Effect.promise(() => fs.readFile(throttleFile, "utf8")))
        expect(data.some((r: any) => r.key === "key1" && r.source === "OPENCODE_API_KEY")).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "falls back to key2 when key1 returns 401",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* llm.errorForKey("key1", 401, { error: "Unauthorized" })
        yield* llm.success("hello")

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2" },
          timeoutMs: 40_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain("KeyRotationRetry")
        expect(result.stderr).not.toContain("Invalid API key")
        expect(result.stderr).not.toContain("/$bunfs/")

        // 401 does NOT write throttle.json
        const exists = yield* Effect.promise(() =>
          fs
            .stat(throttleFile)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "exits nonzero when all keys are throttled",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        const now = Date.now()
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              { source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 7_200_000 },
              { source: "OPENCODE_API_KEY", key: "key2", startTime: now - 1000, endTime: now + 7_200_000 },
            ]),
          ),
        )

        // LLM should not be called at all
        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(10_000)
      }),
    30_000,
  )

  cliIt.live(
    "single key exits nonzero without writing throttle.json when rate limited",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* llm.error(429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 30_000,
        })
        expect(result.exitCode).not.toBe(0)

        const exists = yield* Effect.promise(() =>
          fs
            .stat(throttleFile)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    45_000,
  )

  cliIt.live(
    "throttle disabled: does not read or write throttle.json",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* llm.error(429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "false" },
          timeoutMs: 30_000,
        })
        expect(result.exitCode).not.toBe(0)
        const exists = yield* Effect.promise(() =>
          fs
            .stat(throttleFile)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    45_000,
  )
})
