# Key Rotation & Throttle Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-process throttle suppression and in-process multi-key fallback for `OPENCODE_API_KEY`, writing decisions to `welan.txt` in addition to the existing log channel.

**Architecture:** Three new standalone modules (`throttle-store.ts`, `welan-logger.ts`, `key-rotator.ts`) with zero Effect/Provider dependencies. Integration into `run.ts` via a `runWithKeyRotation` loop that calls `Server.Default.reset()` between key attempts — the lazy singleton re-initializes with the updated env var on the next request, no Effect re-run needed.

**Tech Stack:** Bun, TypeScript, Node.js `fs/promises`, existing `Flock` from `@opencode-ai/core/util/flock`, existing `Global.Path` from `@opencode-ai/core/global`.

## Global Constraints

- All new source files: `packages/opencode/src/provider/`
- All new test files: `packages/opencode/test/provider/` or `packages/opencode/test/cli/run/`
- Run tests from `packages/opencode/` directory (never repo root)
- Test command: `bun test <path>` from `packages/opencode/`
- Typecheck: `bun typecheck` from `packages/opencode/`
- Commits: `git commit -s -S -m "type(scope): summary"`
- No imports of Effect, Provider, Session, or Auth in new modules
- Key masking in logs: last 6 chars only, prefix `***`
- `OPENCODE_API_KEY` split on `,`, trim, drop empty strings
- `OPENCODE_THROTTLE_ENABLE` default `"true"` (disabled only when `=== "false"`)
- `OPENCODE_THROTTLE_DURATION` default `120` minutes
- `OPENCODE_WELAN_LOG` default `"true"` (disabled only when `=== "false"`)
- throttle.json path: `path.join(Global.Path.config, "throttle.json")`
- welan.txt path: `path.join(Global.Path.config, "welan.txt")`
- Flock key for throttle: `"throttle-store"`, `dir: Global.Path.config`, `timeoutMs: 2_000`, `staleMs: 10_000`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/provider/throttle-store.ts` | Create | Read/write throttle.json; Flock-based write locking |
| `src/provider/welan-logger.ts` | Create | Append to welan.txt, fire-and-forget |
| `src/provider/key-rotator.ts` | Create | Parse key list, select next available key |
| `src/session/retry.ts` | Modify | Add `isInvalidKeyAPIError` (~5 lines) |
| `src/cli/cmd/run.ts` | Modify | `execute()` returns `AttemptResult`; add `runWithKeyRotation` |
| `test/provider/throttle-store.test.ts` | Create | Unit tests for ThrottleStore |
| `test/provider/welan-logger.test.ts` | Create | Unit tests for WelANLogger |
| `test/provider/key-rotator.test.ts` | Create | Unit tests for KeyRotator |
| `test/cli/run/run-key-rotation.test.ts` | Create | E2E tests via cliIt.live |

---

## Task 1: ThrottleStore

**Files:**
- Create: `packages/opencode/src/provider/throttle-store.ts`
- Create: `packages/opencode/test/provider/throttle-store.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  // throttle.json record
  type ThrottleRecord = {
    source: string   // env var name, e.g. "OPENCODE_API_KEY"
    key: string      // full API key
    startTime: number  // Unix ms
    endTime: number    // Unix ms
  }

  function isThrottled(source: string, key: string): Promise<boolean>
  function addThrottle(source: string, key: string, durationMinutes: number): Promise<void>
  function cleanExpired(source: string, key: string): Promise<void>
  export * as ThrottleStore from "./throttle-store"
  ```

- [ ] **Step 1: Write the failing tests**

  Create `packages/opencode/test/provider/throttle-store.test.ts`:

  ```typescript
  import { afterEach, describe, expect, it } from "bun:test"
  import path from "path"
  import fs from "fs/promises"
  import os from "os"

  // Override Global.Path.config to a temp dir for tests
  const tmpDir = path.join(os.tmpdir(), "opencode-throttle-test-" + process.pid)
  const throttleFile = path.join(tmpDir, "throttle.json")

  // Patch the global path before importing the module under test
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg")

  // Dynamic import so env patch applies first
  const { ThrottleStore } = await import("../../src/provider/throttle-store")

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.mkdir(tmpDir, { recursive: true })
  })

  describe("ThrottleStore.isThrottled", () => {
    it("returns false when throttle.json does not exist", async () => {
      expect(await ThrottleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
    })

    it("returns true when key has an active throttle record", async () => {
      const now = Date.now()
      await fs.writeFile(
        throttleFile,
        JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 60_000 }]),
      )
      expect(await ThrottleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(true)
    })

    it("returns false when key record is expired", async () => {
      const now = Date.now()
      await fs.writeFile(
        throttleFile,
        JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 120_000, endTime: now - 1000 }]),
      )
      expect(await ThrottleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
    })

    it("returns false for a different key not in the file", async () => {
      const now = Date.now()
      await fs.writeFile(
        throttleFile,
        JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 60_000 }]),
      )
      expect(await ThrottleStore.isThrottled("OPENCODE_API_KEY", "key2")).toBe(false)
    })

    it("returns false on JSON parse error (file is corrupt)", async () => {
      await fs.writeFile(throttleFile, "not-json")
      expect(await ThrottleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
    })
  })

  describe("ThrottleStore.addThrottle", () => {
    it("creates throttle.json with a new record", async () => {
      await ThrottleStore.addThrottle("OPENCODE_API_KEY", "key1", 120)
      const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
      expect(data).toHaveLength(1)
      expect(data[0].source).toBe("OPENCODE_API_KEY")
      expect(data[0].key).toBe("key1")
      expect(data[0].endTime - data[0].startTime).toBe(120 * 60 * 1000)
    })

    it("upserts: updates existing record for same key", async () => {
      await ThrottleStore.addThrottle("OPENCODE_API_KEY", "key1", 60)
      await ThrottleStore.addThrottle("OPENCODE_API_KEY", "key1", 120)
      const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
      expect(data).toHaveLength(1)
      expect(data[0].endTime - data[0].startTime).toBe(120 * 60 * 1000)
    })

    it("appends: keeps other keys when adding a new one", async () => {
      await ThrottleStore.addThrottle("OPENCODE_API_KEY", "key1", 60)
      await ThrottleStore.addThrottle("OPENCODE_API_KEY", "key2", 120)
      const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
      expect(data).toHaveLength(2)
    })
  })

  describe("ThrottleStore.cleanExpired", () => {
    it("removes expired record for the given key", async () => {
      const now = Date.now()
      await fs.writeFile(
        throttleFile,
        JSON.stringify([
          { source: "OPENCODE_API_KEY", key: "key1", startTime: now - 120_000, endTime: now - 1000 },
          { source: "OPENCODE_API_KEY", key: "key2", startTime: now - 1000, endTime: now + 60_000 },
        ]),
      )
      await ThrottleStore.cleanExpired("OPENCODE_API_KEY", "key1")
      const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
      expect(data).toHaveLength(1)
      expect(data[0].key).toBe("key2")
    })

    it("does nothing when key is not in the file", async () => {
      const now = Date.now()
      await fs.writeFile(
        throttleFile,
        JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key2", startTime: now, endTime: now + 60_000 }]),
      )
      await ThrottleStore.cleanExpired("OPENCODE_API_KEY", "key1")
      const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
      expect(data).toHaveLength(1)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd packages/opencode
  bun test test/provider/throttle-store.test.ts 2>&1 | head -20
  ```

  Expected: import error — module does not exist yet.

- [ ] **Step 3: Implement ThrottleStore**

  Create `packages/opencode/src/provider/throttle-store.ts`:

  ```typescript
  import path from "path"
  import fs from "fs/promises"
  import { Flock } from "@opencode-ai/core/util/flock"
  import { Global } from "@opencode-ai/core/global"

  type ThrottleRecord = {
    source: string
    key: string
    startTime: number
    endTime: number
  }

  const filePath = () => path.join(Global.Path.config, "throttle.json")

  async function readRecords(): Promise<ThrottleRecord[]> {
    try {
      const raw = await fs.readFile(filePath(), "utf8")
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed as ThrottleRecord[]
    } catch {
      return []
    }
  }

  async function writeRecords(records: ThrottleRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath()), { recursive: true })
    await fs.writeFile(filePath(), JSON.stringify(records, null, 2))
  }

  export async function isThrottled(source: string, key: string): Promise<boolean> {
    const records = await readRecords()
    const now = Date.now()
    const record = records.find((r) => r.source === source && r.key === key)
    if (!record) return false
    if (now < record.endTime) return true
    // Expired: clean up in the background, do not block
    void cleanExpired(source, key)
    return false
  }

  export async function addThrottle(source: string, key: string, durationMinutes: number): Promise<void> {
    let lease: Awaited<ReturnType<typeof Flock.acquire>> | null = null
    try {
      lease = await Flock.acquire("throttle-store", {
        dir: Global.Path.config,
        timeoutMs: 2_000,
        staleMs: 10_000,
      })
    } catch {
      // Timed out waiting for lock: prefer missing the write over blocking the caller
      return
    }
    try {
      const records = await readRecords()
      const now = Date.now()
      const endTime = now + durationMinutes * 60 * 1000
      const idx = records.findIndex((r) => r.source === source && r.key === key)
      const record: ThrottleRecord = { source, key, startTime: now, endTime }
      if (idx >= 0) records[idx] = record
      else records.push(record)
      await writeRecords(records)
    } finally {
      await lease.release()
    }
  }

  export async function cleanExpired(source: string, key: string): Promise<void> {
    let lease: Awaited<ReturnType<typeof Flock.acquire>> | null = null
    try {
      lease = await Flock.acquire("throttle-store", {
        dir: Global.Path.config,
        timeoutMs: 2_000,
        staleMs: 10_000,
      })
    } catch {
      return
    }
    try {
      const records = await readRecords()
      const now = Date.now()
      const filtered = records.filter((r) => !(r.source === source && r.key === key && now >= r.endTime))
      await writeRecords(filtered)
    } finally {
      await lease.release()
    }
  }

  export * as ThrottleStore from "./throttle-store"
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cd packages/opencode
  bun test test/provider/throttle-store.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 5: Typecheck**

  ```bash
  cd packages/opencode
  bun typecheck
  ```

  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  cd packages/opencode
  git add src/provider/throttle-store.ts test/provider/throttle-store.test.ts
  git commit -s -S -m "feat(opencode): add ThrottleStore for cross-process key throttle suppression"
  ```

---

## Task 2: WelANLogger

**Files:**
- Create: `packages/opencode/src/provider/welan-logger.ts`
- Create: `packages/opencode/test/provider/welan-logger.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  type Level = "info" | "warn" | "error"
  function log(level: Level, message: string): void  // fire-and-forget
  export * as WelANLogger from "./welan-logger"
  ```

- [ ] **Step 1: Write the failing test**

  Create `packages/opencode/test/provider/welan-logger.test.ts`:

  ```typescript
  import { afterEach, describe, expect, it } from "bun:test"
  import path from "path"
  import fs from "fs/promises"
  import os from "os"

  const tmpDir = path.join(os.tmpdir(), "opencode-welan-test-" + process.pid)
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg")

  const { WelANLogger } = await import("../../src/provider/welan-logger")

  const welanFile = path.join(tmpDir, "welan.txt")

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.mkdir(tmpDir, { recursive: true })
    delete process.env.OPENCODE_WELAN_LOG
  })

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
  }

  describe("WelANLogger.log", () => {
    it("appends a line to welan.txt with correct format", async () => {
      WelANLogger.log("info", "test message")
      await sleep(50) // fire-and-forget: wait for write
      const content = await fs.readFile(welanFile, "utf8")
      expect(content).toMatch(/\[.*\] \[INFO\] test message\n/)
    })

    it("appends multiple lines in order", async () => {
      WelANLogger.log("info", "first")
      WelANLogger.log("warn", "second")
      await sleep(50)
      const content = await fs.readFile(welanFile, "utf8")
      const lines = content.trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("[INFO] first")
      expect(lines[1]).toContain("[WARN] second")
    })

    it("does nothing when OPENCODE_WELAN_LOG=false", async () => {
      process.env.OPENCODE_WELAN_LOG = "false"
      WelANLogger.log("info", "should not appear")
      await sleep(50)
      const exists = await fs.stat(welanFile).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd packages/opencode
  bun test test/provider/welan-logger.test.ts 2>&1 | head -10
  ```

  Expected: import error.

- [ ] **Step 3: Implement WelANLogger**

  Create `packages/opencode/src/provider/welan-logger.ts`:

  ```typescript
  import path from "path"
  import fs from "fs/promises"
  import { Global } from "@opencode-ai/core/global"

  export type Level = "info" | "warn" | "error"

  const filePath = () => path.join(Global.Path.config, "welan.txt")

  export function log(level: Level, message: string): void {
    if (process.env.OPENCODE_WELAN_LOG === "false") return
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`
    // Fire-and-forget: never block the caller
    void fs
      .mkdir(path.dirname(filePath()), { recursive: true })
      .then(() => fs.appendFile(filePath(), line))
      .catch(() => {})
  }

  export * as WelANLogger from "./welan-logger"
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cd packages/opencode
  bun test test/provider/welan-logger.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 5: Typecheck and commit**

  ```bash
  cd packages/opencode
  bun typecheck
  git add src/provider/welan-logger.ts test/provider/welan-logger.test.ts
  git commit -s -S -m "feat(opencode): add WelANLogger for supplemental welan.txt logging"
  ```

---

## Task 3: KeyRotator

**Files:**
- Create: `packages/opencode/src/provider/key-rotator.ts`
- Create: `packages/opencode/test/provider/key-rotator.test.ts`

**Interfaces:**
- Consumes: `ThrottleStore.isThrottled`, `ThrottleStore.addThrottle`, `WelANLogger.log`
- Produces:
  ```typescript
  function parseKeys(): string[]

  class KeyRotator {
    constructor(keys: string[])
    async selectKey(): Promise<string | null>
    async recordThrottle(key: string): Promise<void>
    markInvalid(key: string): void
    hasAlternative(currentKey: string): boolean
  }

  export * as KeyRotator from "./key-rotator"
  ```

- [ ] **Step 1: Write the failing tests**

  Create `packages/opencode/test/provider/key-rotator.test.ts`:

  ```typescript
  import { afterEach, describe, expect, it, mock } from "bun:test"

  // Mock ThrottleStore before importing KeyRotator
  const mockIsThrottled = mock(async (_source: string, _key: string) => false)
  const mockAddThrottle = mock(async (_source: string, _key: string, _dur: number) => {})

  mock.module("../../src/provider/throttle-store", () => ({
    ThrottleStore: { isThrottled: mockIsThrottled, addThrottle: mockAddThrottle, cleanExpired: async () => {} },
  }))

  const { KeyRotator, parseKeys } = await import("../../src/provider/key-rotator")

  afterEach(() => {
    mockIsThrottled.mockReset()
    mockAddThrottle.mockReset()
    mockIsThrottled.mockImplementation(async () => false)
    delete process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_THROTTLE_ENABLE
    delete process.env.OPENCODE_THROTTLE_DURATION
  })

  describe("parseKeys", () => {
    it("returns empty array when env var not set", () => {
      delete process.env.OPENCODE_API_KEY
      expect(parseKeys()).toEqual([])
    })

    it("returns single key", () => {
      process.env.OPENCODE_API_KEY = "sk-abc"
      expect(parseKeys()).toEqual(["sk-abc"])
    })

    it("returns multiple keys split by comma", () => {
      process.env.OPENCODE_API_KEY = "sk-abc,sk-def,sk-ghi"
      expect(parseKeys()).toEqual(["sk-abc", "sk-def", "sk-ghi"])
    })

    it("trims whitespace around commas", () => {
      process.env.OPENCODE_API_KEY = "sk-abc , sk-def"
      expect(parseKeys()).toEqual(["sk-abc", "sk-def"])
    })

    it("drops empty strings after split", () => {
      process.env.OPENCODE_API_KEY = "sk-abc,,sk-def"
      expect(parseKeys()).toEqual(["sk-abc", "sk-def"])
    })
  })

  describe("KeyRotator.selectKey", () => {
    it("returns first key when none are throttled or invalid", async () => {
      const r = new KeyRotator(["key1", "key2"])
      expect(await r.selectKey()).toBe("key1")
    })

    it("skips throttled key and returns next", async () => {
      mockIsThrottled.mockImplementation(async (_s, key) => key === "key1")
      const r = new KeyRotator(["key1", "key2"])
      expect(await r.selectKey()).toBe("key2")
    })

    it("skips invalid key and returns next", async () => {
      const r = new KeyRotator(["key1", "key2"])
      r.markInvalid("key1")
      expect(await r.selectKey()).toBe("key2")
    })

    it("returns null when all keys are throttled", async () => {
      mockIsThrottled.mockImplementation(async () => true)
      const r = new KeyRotator(["key1", "key2"])
      expect(await r.selectKey()).toBeNull()
    })

    it("returns null when all keys are invalid", async () => {
      const r = new KeyRotator(["key1", "key2"])
      r.markInvalid("key1")
      r.markInvalid("key2")
      expect(await r.selectKey()).toBeNull()
    })

    it("skips throttle check when OPENCODE_THROTTLE_ENABLE=false", async () => {
      process.env.OPENCODE_THROTTLE_ENABLE = "false"
      mockIsThrottled.mockImplementation(async () => true) // would throttle if checked
      const r = new KeyRotator(["key1"])
      expect(await r.selectKey()).toBe("key1") // not skipped because throttle disabled
      expect(mockIsThrottled).not.toHaveBeenCalled()
    })
  })

  describe("KeyRotator.recordThrottle", () => {
    it("calls ThrottleStore.addThrottle with correct source and default duration", async () => {
      const r = new KeyRotator(["key1"])
      await r.recordThrottle("key1")
      expect(mockAddThrottle).toHaveBeenCalledWith("OPENCODE_API_KEY", "key1", 120)
    })

    it("uses OPENCODE_THROTTLE_DURATION when set", async () => {
      process.env.OPENCODE_THROTTLE_DURATION = "60"
      const r = new KeyRotator(["key1"])
      await r.recordThrottle("key1")
      expect(mockAddThrottle).toHaveBeenCalledWith("OPENCODE_API_KEY", "key1", 60)
    })
  })

  describe("KeyRotator.markInvalid", () => {
    it("causes the key to be skipped in selectKey", async () => {
      const r = new KeyRotator(["key1", "key2"])
      r.markInvalid("key1")
      expect(await r.selectKey()).toBe("key2")
    })

    it("does not write to throttle.json", async () => {
      const r = new KeyRotator(["key1"])
      r.markInvalid("key1")
      expect(mockAddThrottle).not.toHaveBeenCalled()
    })
  })

  describe("KeyRotator.hasAlternative", () => {
    it("returns true when other non-invalid keys exist", () => {
      const r = new KeyRotator(["key1", "key2", "key3"])
      expect(r.hasAlternative("key1")).toBe(true)
    })

    it("returns false when only one key and it is current", () => {
      const r = new KeyRotator(["key1"])
      expect(r.hasAlternative("key1")).toBe(false)
    })

    it("returns false when other keys are all invalid", () => {
      const r = new KeyRotator(["key1", "key2"])
      r.markInvalid("key2")
      expect(r.hasAlternative("key1")).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd packages/opencode
  bun test test/provider/key-rotator.test.ts 2>&1 | head -10
  ```

  Expected: import error.

- [ ] **Step 3: Implement KeyRotator**

  Create `packages/opencode/src/provider/key-rotator.ts`:

  ```typescript
  import { ThrottleStore } from "./throttle-store"
  import { WelANLogger } from "./welan-logger"

  const SOURCE = "OPENCODE_API_KEY"

  export function parseKeys(): string[] {
    const raw = process.env.OPENCODE_API_KEY ?? ""
    return raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
  }

  function throttleDuration(): number {
    const raw = process.env.OPENCODE_THROTTLE_DURATION
    const parsed = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 120
  }

  function isThrottleEnabled(): boolean {
    return process.env.OPENCODE_THROTTLE_ENABLE !== "false"
  }

  function maskKey(key: string): string {
    return `***${key.slice(-6)}`
  }

  export class KeyRotator {
    private readonly invalid = new Set<string>()

    constructor(private readonly keys: string[]) {}

    async selectKey(): Promise<string | null> {
      for (const key of this.keys) {
        if (this.invalid.has(key)) continue
        if (isThrottleEnabled() && (await ThrottleStore.isThrottled(SOURCE, key))) {
          WelANLogger.log("info", `key-rotation: key ${maskKey(key)} is throttled, skipping`)
          continue
        }
        return key
      }
      return null
    }

    async recordThrottle(key: string): Promise<void> {
      const duration = throttleDuration()
      WelANLogger.log(
        "warn",
        `key-rotation: key ${maskKey(key)} throttled for ${duration} minutes, writing throttle record`,
      )
      await ThrottleStore.addThrottle(SOURCE, key, duration)
    }

    markInvalid(key: string): void {
      WelANLogger.log("warn", `key-rotation: key ${maskKey(key)} marked invalid (401), skipping for this process`)
      this.invalid.add(key)
    }

    hasAlternative(currentKey: string): boolean {
      return this.keys.some((k) => k !== currentKey && !this.invalid.has(k))
    }
  }

  export * as KeyRotator from "./key-rotator"
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cd packages/opencode
  bun test test/provider/key-rotator.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 5: Typecheck and commit**

  ```bash
  cd packages/opencode
  bun typecheck
  git add src/provider/key-rotator.ts test/provider/key-rotator.test.ts
  git commit -s -S -m "feat(opencode): add KeyRotator for OPENCODE_API_KEY multi-key rotation"
  ```

---

## Task 4: retry.ts — add isInvalidKeyAPIError

**Files:**
- Modify: `packages/opencode/src/session/retry.ts` (add ~5 lines after `isQuotaOrRateLimitAPIError`)

**Interfaces:**
- Consumes: existing `isRecord` from `@/util/record`
- Produces:
  ```typescript
  export function isInvalidKeyAPIError(error: unknown): boolean
  // → true if error.name === "APIError" && error.data.statusCode === 401
  ```

- [ ] **Step 1: Add the function**

  In `packages/opencode/src/session/retry.ts`, after the `isQuotaOrRateLimitAPIError` function (currently ending at line 62), add:

  ```typescript
  export function isInvalidKeyAPIError(error: unknown): boolean {
    if (!isRecord(error) || error.name !== "APIError" || !isRecord(error.data)) return false
    return error.data.statusCode === 401
  }
  ```

- [ ] **Step 2: Verify the export is re-exported**

  The file already ends with `export * as SessionRetry from "./retry"` — no change needed there.

- [ ] **Step 3: Typecheck**

  ```bash
  cd packages/opencode
  bun typecheck
  ```

  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  cd packages/opencode
  git add src/session/retry.ts
  git commit -s -S -m "feat(opencode): add isInvalidKeyAPIError to retry helpers"
  ```

---

## Task 5: run.ts — AttemptResult + runWithKeyRotation

**Files:**
- Modify: `packages/opencode/src/cli/cmd/run.ts`

**Interfaces:**
- Consumes: `KeyRotator` (parse/class), `WelANLogger.log`, `SessionRetry.isInvalidKeyAPIError`, `Server.Default.reset` from `@/server/server`
- The `execute()` function internal to the `Effect.promise` callback is modified to return `AttemptResult` instead of `string | undefined`.

**Context for this task:** In `run.ts`, the non-interactive, non-attach code path (around line 954) creates an embedded server via `Server.Default()` inside a lazy `fetchFn`, creates an SDK, then calls `execute(sdk)`. The `execute` function (line 671) creates or retrieves a session, runs the event loop, and currently returns `string | undefined` (error or undefined). `Server.Default` is a lazy singleton; calling `Server.Default.reset()` clears the cached instance so the next HTTP request creates a fresh server — which re-reads `process.env.OPENCODE_API_KEY`.

- [ ] **Step 1: Add import for KeyRotator and WelANLogger**

  At the top of `packages/opencode/src/cli/cmd/run.ts`, after the existing imports, add:

  ```typescript
  import { KeyRotator, parseKeys } from "@/provider/key-rotator"
  import { WelANLogger } from "@/provider/welan-logger"
  ```

  Also add `isInvalidKeyAPIError` to the existing SessionRetry import:

  ```typescript
  // existing line (around line 28):
  import { SessionRetry } from "@/session/retry"
  // SessionRetry now also exports isInvalidKeyAPIError via the namespace re-export
  ```

  No change needed to the SessionRetry import — `isInvalidKeyAPIError` is already re-exported via `export * as SessionRetry from "./retry"`.

- [ ] **Step 2: Add AttemptResult type**

  After the existing `type ModelInput = ...` line (around line 30), add:

  ```typescript
  type AttemptResult = {
    sessionID: string | undefined
    exitReason: "success" | "quota_limit" | "invalid_key" | "error"
    error?: string
  }
  ```

- [ ] **Step 3: Modify execute() to return AttemptResult**

  The `execute` function (line 671) currently returns `Promise<string | undefined>` implicitly. Modify:

  a. Change function signature comment: the function now returns `Promise<AttemptResult>`.

  b. At the top of `execute`, add a variable to track the session ID:
  ```typescript
  async function execute(sdk: OpencodeClient, overrideSessionID?: string): Promise<AttemptResult> {
    // If key rotation provided a session ID from a prior attempt, pass it via args.session override
    const sess = await session(sdk, overrideSessionID)
  ```

  Modify the `session` helper to accept an optional override:
  ```typescript
  async function session(sdk: OpencodeClient, overrideID?: string): Promise<SessionInfo | undefined> {
    const id = overrideID ?? args.session
    if (id) {
      // ... existing args.session branch but using `id` instead of `args.session`
  ```

  c. Replace every `return error` inside `loop()` and `execute()` with a structured return:
  - Rate-limit return: `return { sessionID, exitReason: "quota_limit", error }`
  - Invalid key return: `return { sessionID, exitReason: "invalid_key", error }`
  - Normal end (after `await finish()`): `return { sessionID, exitReason: "success" }`
  - Error exit: `return { sessionID, exitReason: "error", error }`

  Specifically, in `loop()`:

  ```typescript
  // Replace (line ~785-791):
  const limit = SessionRetry.isQuotaOrRateLimitAPIError(props.error)
  if (emit("error", { error: props.error })) {
    if (limit) return error
    continue
  }
  UI.error(err)
  if (limit) return error

  // With:
  const isQuota = SessionRetry.isQuotaOrRateLimitAPIError(props.error)
  const isInvalid = SessionRetry.isInvalidKeyAPIError(props.error)
  if (emit("error", { error: props.error })) {
    if (isQuota) return { exitReason: "quota_limit", error }
    if (isInvalid) return { exitReason: "invalid_key", error }
    continue
  }
  UI.error(err)
  if (isQuota) return { exitReason: "quota_limit", error }
  if (isInvalid) return { exitReason: "invalid_key", error }
  ```

  And for the retry-status block (line ~796-800):
  ```typescript
  // Replace:
  if (status.type === "retry" && SessionRetry.isQuotaOrRateLimitRetryStatus(status)) {
    error = error ? error + EOL + status.message : status.message
    if (emit("error", { error: status })) return error
    UI.error(status.message)
    return error
  }

  // With:
  if (status.type === "retry" && SessionRetry.isQuotaOrRateLimitRetryStatus(status)) {
    error = error ? error + EOL + status.message : status.message
    if (emit("error", { error: status })) return { sessionID, exitReason: "quota_limit", error }
    UI.error(status.message)
    return { sessionID, exitReason: "quota_limit", error }
  }
  ```

  `loop()` now returns `Promise<{ exitReason: "quota_limit" | "invalid_key"; error: string } | undefined>` instead of `Promise<string | undefined>`. The `execute()` caller of `loop()` updates accordingly.

  The final success path in `execute()`:
  ```typescript
  await finish()
  return { sessionID, exitReason: "success" }
  ```

- [ ] **Step 4: Add runWithKeyRotation and wire up the non-interactive path**

  Add this function inside the `Effect.promise(async () => { ... })` block, after the existing helper functions (`session`, `share`, `execute`, etc.) but before the final path branches. In `run.ts`, the non-interactive non-attach branch (currently ending with `await execute(sdk)` around line 967) is replaced:

  ```typescript
  // New function inside the async block:
  async function runWithKeyRotation(createSdk: () => OpencodeClient): Promise<void> {
    const { Server } = await import("@/server/server")
    const keys = parseKeys()
    const rotator = new KeyRotator(keys)
    let currentSessionID: string | undefined = args.session

    WelANLogger.log("info", `key-rotation: start, ${keys.length} key(s) configured`)

    let attempt = 0
    while (true) {
      const key = await rotator.selectKey()
      if (!key) {
        WelANLogger.log("error", "key-rotation: all OPENCODE_API_KEY keys exhausted or throttled")
        process.exitCode = 1
        return
      }

      attempt++
      process.env.OPENCODE_API_KEY = key
      if (attempt > 1) Server.Default.reset()  // force fresh server with new key
      WelANLogger.log("info", `key-rotation: attempt ${attempt} with key ***${key.slice(-6)}`)

      const result = await execute(createSdk(), currentSessionID)
      currentSessionID = result.sessionID ?? currentSessionID

      if (result.exitReason === "quota_limit") {
        await rotator.recordThrottle(key)
        WelANLogger.log(
          "warn",
          `key-rotation: key ***${key.slice(-6)} quota_limit, ${rotator.hasAlternative(key) ? "trying next" : "no more keys"}`,
        )
        if (!rotator.hasAlternative(key)) {
          if (result.error) process.exitCode = 1
          return
        }
        continue
      }

      if (result.exitReason === "invalid_key") {
        rotator.markInvalid(key)
        WelANLogger.log(
          "warn",
          `key-rotation: key ***${key.slice(-6)} invalid, ${rotator.hasAlternative(key) ? "trying next" : "no more keys"}`,
        )
        if (!rotator.hasAlternative(key)) {
          if (result.error) process.exitCode = 1
          return
        }
        continue
      }

      if (result.exitReason === "error" || result.error) {
        process.exitCode = 1
      }
      WelANLogger.log("info", `key-rotation: ${result.exitReason} with key ***${key.slice(-6)}`)
      return
    }
  }
  ```

  Replace the existing non-interactive non-attach tail (lines ~954-967):

  ```typescript
  // Before (existing):
  const fetchFn = (async (input, init?) => {
    const { Server } = await import("@/server/server")
    ...
    return Server.Default().app.fetch(...)
  }) as typeof globalThis.fetch
  const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn, directory })
  await execute(sdk)

  // After:
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Server } = await import("@/server/server")
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    const auth = ServerAuth.header()
    if (auth) headers.set("Authorization", auth)
    return Server.Default().app.fetch(new Request(request, { headers }))
  }) as typeof globalThis.fetch

  const createSdk = () =>
    createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn, directory })

  await runWithKeyRotation(createSdk)
  ```

- [ ] **Step 5: Run gofmt equivalent (TypeScript formatter)**

  ```bash
  cd packages/opencode
  bun typecheck
  ```

  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  cd packages/opencode
  git add src/cli/cmd/run.ts src/session/retry.ts
  git commit -s -S -m "feat(opencode): integrate key rotation loop into run command"
  ```

---

## Task 6: E2E Tests

**Files:**
- Create: `packages/opencode/test/cli/run/run-key-rotation.test.ts`

**Context:** These tests follow the pattern in `test/cli/run/run-process-limit.test.ts`. `cliIt.live` spawns a real `opencode run` subprocess against a mock LLM server (`llm`). The test sets `OPENCODE_API_KEY` to comma-separated keys and controls which one the mock server accepts.

- [ ] **Step 1: Write the E2E tests**

  Create `packages/opencode/test/cli/run/run-key-rotation.test.ts`:

  ```typescript
  // Key rotation behavior for `opencode run` (non-interactive subprocess).
  // Kept in a separate file to avoid competing with the main CLI regression suite.
  import { afterEach, beforeEach, describe, expect } from "bun:test"
  import path from "path"
  import fs from "fs/promises"
  import os from "os"
  import { Effect } from "effect"
  import { cliIt } from "../../lib/cli-process"

  const tmpDir = path.join(os.tmpdir(), "opencode-key-rotation-e2e-" + process.pid)
  const throttleFile = path.join(tmpDir, "throttle.json")

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg")
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    delete process.env.OPENCODE_API_KEY
    delete process.env.XDG_CONFIG_HOME
  })

  describe("opencode run key rotation (non-interactive subprocess)", () => {
    cliIt.live(
      "uses key2 when throttle.json marks key1 as throttled at startup",
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          // Pre-seed throttle.json: key1 is throttled
          const now = Date.now()
          await fs.mkdir(path.dirname(throttleFile), { recursive: true })
          await fs.writeFile(
            throttleFile,
            JSON.stringify([
              {
                source: "OPENCODE_API_KEY",
                key: "key1",
                startTime: now - 1000,
                endTime: now + 7_200_000, // 2 hours from now
              },
            ]),
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
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          // key1: 429, key2: success
          yield* llm.errorForKey("key1", 429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })
          yield* llm.success("hello from key2")

          const result = yield* opencode.run("say hi", {
            env: { OPENCODE_API_KEY: "key1,key2", OPENCODE_THROTTLE_ENABLE: "true" },
            timeoutMs: 40_000,
          })
          expect(result.exitCode).toBe(0)

          // throttle.json should now have key1
          const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
          expect(data.some((r: any) => r.key === "key1" && r.source === "OPENCODE_API_KEY")).toBe(true)
        }),
      60_000,
    )

    cliIt.live(
      "falls back to key2 when key1 returns 401",
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          yield* llm.errorForKey("key1", 401, { error: "Unauthorized" })
          yield* llm.success("hello")

          const result = yield* opencode.run("say hi", {
            env: { OPENCODE_API_KEY: "key1,key2" },
            timeoutMs: 40_000,
          })
          expect(result.exitCode).toBe(0)

          // 401 does NOT write throttle.json
          const exists = await fs.stat(throttleFile).then(() => true).catch(() => false)
          expect(exists).toBe(false)
        }),
      60_000,
    )

    cliIt.live(
      "exits nonzero when all keys are throttled",
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          const now = Date.now()
          await fs.mkdir(path.dirname(throttleFile), { recursive: true })
          await fs.writeFile(
            throttleFile,
            JSON.stringify([
              { source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 7_200_000 },
              { source: "OPENCODE_API_KEY", key: "key2", startTime: now - 1000, endTime: now + 7_200_000 },
            ]),
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
      "single key still writes throttle.json when rate limited",
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          yield* llm.error(429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })

          const result = yield* opencode.run("say hi", {
            env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "true" },
            timeoutMs: 30_000,
          })
          expect(result.exitCode).not.toBe(0)

          // throttle.json written even for single key
          const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
          expect(data.some((r: any) => r.key === "key1")).toBe(true)
        }),
      45_000,
    )

    cliIt.live(
      "throttle disabled: does not read or write throttle.json",
      ({ llm, opencode }) =>
        Effect.gen(function* () {
          yield* llm.error(429, { type: "error", error: { type: "RateLimitError", message: "Rate limit" } })

          const result = yield* opencode.run("say hi", {
            env: { OPENCODE_API_KEY: "key1", OPENCODE_THROTTLE_ENABLE: "false" },
            timeoutMs: 30_000,
          })
          expect(result.exitCode).not.toBe(0)
          const exists = await fs.stat(throttleFile).then(() => true).catch(() => false)
          expect(exists).toBe(false)
        }),
      45_000,
    )
  })
  ```

- [ ] **Step 2: Verify the test runner recognizes the new test**

  ```bash
  cd packages/opencode
  bun test test/cli/run/run-key-rotation.test.ts --list 2>&1
  ```

  Expected: lists the 6 test cases without errors.

- [ ] **Step 3: Run E2E tests**

  ```bash
  cd packages/opencode
  bun test test/cli/run/run-key-rotation.test.ts --timeout 120000
  ```

  Expected: all 6 tests pass. These are slow (30–60 s each); total runtime ~5 min.

- [ ] **Step 4: Commit**

  ```bash
  cd packages/opencode
  git add test/cli/run/run-key-rotation.test.ts
  git commit -s -S -m "test(opencode): add E2E tests for key rotation and throttle suppression"
  ```

---

## Spec Coverage Check

| Spec requirement | Covered by task |
|---|---|
| `OPENCODE_API_KEY=key1,key2` multi-key parsing | Task 3 (parseKeys) |
| throttle.json cross-process persistence | Task 1 (ThrottleStore) |
| Flock-based write locking, crash recovery | Task 1 (uses existing Flock with staleMs) |
| Lockless reads | Task 1 (`isThrottled` — no lock) |
| Throttle on 429/quota error | Task 5 (quota_limit branch) |
| Fallback on 401/invalid key | Task 5 (invalid_key branch) |
| No throttle write on 401 | Task 5 + Task 6 (E2E asserts no throttle file) |
| Single key still writes throttle.json | Task 5 + Task 6 |
| `OPENCODE_THROTTLE_ENABLE=false` disables throttle | Task 3, Task 6 |
| `OPENCODE_THROTTLE_DURATION` configures window | Task 3 |
| `OPENCODE_WELAN_LOG=false` disables welan.txt | Task 2 |
| welan.txt append logging | Task 2, Task 3 |
| Session ID threaded across attempts | Task 5 (overrideSessionID) |
| Server re-initialized between key attempts | Task 5 (Server.Default.reset()) |
| Unit tests for ThrottleStore | Task 1 |
| Unit tests for KeyRotator | Task 3 |
| E2E tests | Task 6 |
