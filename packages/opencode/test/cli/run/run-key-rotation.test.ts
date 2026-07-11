// Key rotation behavior for `opencode run` (non-interactive subprocess).
// Kept in a separate file to avoid competing with the main CLI regression suite.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

const zenLimitErrorTypes = ["RateLimitError", "FreeUsageLimitError", "GoUsageLimitError", "BlackUsageLimitError"]

async function hashKey(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function localTime(time: number) {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

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
        const keyHash = yield* Effect.promise(() => hashKey("key1"))
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key1",
                key_hash: keyHash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000), // 2 hours from now
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

  for (const type of zenLimitErrorTypes) {
    cliIt.live(
      `falls back to key2 and writes throttle.json when key1 returns ${type}`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
          yield* llm.errorForKey("key1", 429, { type: "error", error: { type, message: "Usage limit reached" } })
          yield* llm.success("hello from key2")

          const result = yield* opencode.run("say hi", {
            env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true", OPENCODE_PRINT_LOGS: "1" },
            timeoutMs: 40_000,
          })
          expect(result.exitCode).toBe(0)
          expect(result.stderr).not.toContain("KeyRotationRetry")
          expect(result.stderr).not.toContain("/$bunfs/")
          expect(result.stderr).not.toContain("OPENCODE_QUOTA_LIMIT")
          expect(result.stderr).toMatch(/level=ERROR.*key-rotation: key .* quota_limit/)

          const keyHash = yield* Effect.promise(() => hashKey("key1"))
          const data = JSON.parse(yield* Effect.promise(() => fs.readFile(throttleFile, "utf8")))
          expect(
            data.some(
              (r: { key_hash: string; source: string }) => r.key_hash === keyHash && r.source === "OPENCODE_API_KEY",
            ),
          ).toBe(true)
          expect(JSON.stringify(data)).not.toContain("\"key\"")
        }),
      60_000,
    )
  }

  cliIt.live(
    "falls back to key2 when key1 returns 401",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* llm.errorForKey("key1", 401, { error: "Unauthorized" })
        yield* llm.success("hello")

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_PRINT_LOGS: "1" },
          timeoutMs: 40_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain("KeyRotationRetry")
        expect(result.stderr).not.toContain("Invalid API key")
        expect(result.stderr).not.toContain("/$bunfs/")
        expect(result.stderr).toMatch(/level=ERROR.*key-rotation: key .* invalid/)

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
        const key1Hash = yield* Effect.promise(() => hashKey("key1"))
        const key2Hash = yield* Effect.promise(() => hashKey("key2"))
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key1",
                key_hash: key1Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key2",
                key_hash: key2Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
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
        expect(result.stderr).toContain(
          "OPENCODE_QUOTA_LIMIT: all configured API keys are exhausted or throttled",
        )
      }),
    30_000,
  )

  cliIt.live(
    "--format json still prints key exhaustion on stderr",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const now = Date.now()
        const key1Hash = yield* Effect.promise(() => hashKey("key1"))
        const key2Hash = yield* Effect.promise(() => hashKey("key2"))
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key1",
                key_hash: key1Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key2",
                key_hash: key2Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
            ]),
          ),
        )

        const result = yield* opencode.run("hi", {
          format: "json",
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(
          "OPENCODE_QUOTA_LIMIT: all configured API keys are exhausted or throttled",
        )
        expect(result.stdout).toBe("")
      }),
    30_000,
  )

  cliIt.live(
    "writes key-rotation error logs when all keys are throttled at startup",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const now = Date.now()
        const key1Hash = yield* Effect.promise(() => hashKey("key1"))
        const key2Hash = yield* Effect.promise(() => hashKey("key2"))
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        const welanLog = path.join(home, ".config", "opencode", "welan-log.txt")
        yield* Effect.promise(() => fs.mkdir(path.dirname(throttleFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key1",
                key_hash: key1Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
              {
                source: "OPENCODE_API_KEY",
                key_hint: "***key2",
                key_hash: key2Hash,
                startTime: localTime(now - 1000),
                endTime: localTime(now + 7_200_000),
              },
            ]),
          ),
        )

        const result = yield* opencode.run("hi", {
          printLogs: true,
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toMatch(/level=INFO.*key-rotation: key .* is throttled, skipping/)
        expect(result.stderr).toMatch(
          /level=ERROR.*key-rotation: all OPENCODE_API_KEY keys exhausted or throttled/,
        )

        const welan = yield* Effect.promise(() => fs.readFile(welanLog, "utf8"))
        expect(welan).toContain("[INFO] key-rotation: key ***key1 is throttled, skipping")
        expect(welan).toContain("[INFO] key-rotation: key ***key2 is throttled, skipping")
        expect(welan).toContain("[ERROR] key-rotation: all OPENCODE_API_KEY keys exhausted or throttled")
      }),
    30_000,
  )

  cliIt.live(
    "prints one quota marker when every key returns a quota limit",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.errorForKey("key1", 429, {
          type: "error",
          error: { type: "RateLimitError", message: "key1 quota reached" },
        })
        yield* llm.errorForKey("key2", 429, {
          type: "error",
          error: { type: "RateLimitError", message: "key2 quota reached" },
        })

        const result = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 40_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("OPENCODE_QUOTA_LIMIT: key2 quota reached")
        expect(result.stderr.match(/OPENCODE_QUOTA_LIMIT/g)).toHaveLength(1)
      }),
    60_000,
  )

  cliIt.live(
    "single key writes throttle.json and later invocation skips it after quota limit",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const throttleFile = path.join(home, ".config", "opencode", "throttle.json")
        yield* llm.error(429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })

        const first = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 30_000,
        })
        expect(first.exitCode).not.toBe(0)

        const keyHash = yield* Effect.promise(() => hashKey("key1"))
        const data = JSON.parse(yield* Effect.promise(() => fs.readFile(throttleFile, "utf8")))
        expect(
          data.some(
            (record: { key_hash: string; source: string }) =>
              record.key_hash === keyHash && record.source === "OPENCODE_API_KEY",
          ),
        ).toBe(true)

        const second = yield* opencode.run("say hi", {
          env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "true" },
          timeoutMs: 30_000,
        })
        expect(second.exitCode).not.toBe(0)
        expect(second.stderr).toContain(
          "OPENCODE_QUOTA_LIMIT: all configured API keys are exhausted or throttled",
        )
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
