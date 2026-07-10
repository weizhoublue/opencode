# Design: OPENCODE_API_KEY Multi-Key Rotation & Throttle Suppression

**Date**: 2026-07-09  
**Status**: Approved  
**Scope**: `packages/opencode` only; OPENCODE_API_KEY provider

---

## Background

Two prior commits set the foundation:

- **a617679**: When the API returns a quota/rate-limit error, `opencode run` exits immediately instead of waiting.
- **b35fe2e**: `OPENCODE_API_KEY` env var takes priority over stored keys.

This feature builds on both to add:
1. **Cross-process throttle suppression** — a shared file records throttled keys so subsequent CLI processes skip them automatically.
2. **In-process multi-key fallback** — `OPENCODE_API_KEY=key1,key2,key3` enables automatic key rotation within the same `opencode run` invocation.
3. **Supplemental rotation log** — key rotation decisions are logged to `~/.config/opencode/welan-log.txt` and to the existing structured opencode log channel.

---

## Architecture Overview

```
OPENCODE_API_KEY=key1,key2,key3
        │
        ▼
┌──────────────────────────────────────────────────────┐
│  run.ts  outer rotation loop  (new ~40 lines)        │
│                                                      │
│  loop:                                               │
│    key = rotator.selectKey()       ◄─────────────┐  │
│    process.env.OPENCODE_API_KEY = key             │  │
│    runAttempt(args, sessionID)                     │  │
│    KeyRotationRetry carries sessionID              │  │
│                                                   │  │
│    quota_limit  → rotator.recordThrottle(key) ────┘  │
│    invalid_key  → rotator.markInvalid(key)   ────┘   │
│    success/other err → break                         │
└──────────────────────────────────────────────────────┘
         │ each attempt re-runs full Effect program
         ▼
   dispose current directory InstanceState
   reset embedded server lazy handler
   next local fetch reads updated process.env.OPENCODE_API_KEY
         │
         ▼  same SQLite DB on disk
   session context preserved across attempts

┌─────────────────────────────────────┐
│  KeyRotator  (key-rotator.ts)       │
│  - parse comma-separated key list   │
│  - selectKey(): skip throttled +    │
│    in-process invalid keys          │
│  - recordThrottle() / markInvalid() │
└─────────────────┬───────────────────┘
                  │ reads/writes
                  ▼
┌─────────────────────────────────────┐
│  ThrottleStore  (throttle-store.ts) │
│  ~/.config/opencode/throttle.json   │
│  - isThrottled(key): lockless read  │
│  - addThrottle(key): Flock write    │
│  - cleanExpired(key): Flock write   │
└─────────────────────────────────────┘
                  +
┌─────────────────────────────────────┐
│  RotationLogger  (rotation-logger.ts)│
│  ~/.config/opencode/welan-log.txt   │
│  + opencode.log structured format    │
│  OPENCODE_WELAN_LOG=true (default)  │
└─────────────────────────────────────┘
```

### New files

```
packages/opencode/src/provider/
  ├── throttle-store.ts   (new)
  ├── key-rotator.ts      (new)
  └── rotation-logger.ts  (new)

packages/opencode/test/provider/
  ├── throttle-store.test.ts  (new)
  └── key-rotator.test.ts     (new)

packages/opencode/test/cli/run/
  └── run-key-rotation.test.ts  (new)
```

### Modified files

```
packages/opencode/src/cli/cmd/run.ts    (~40 lines: outer rotation loop)
packages/opencode/src/session/retry.ts  (~5 lines: add isInvalidKeyAPIError)
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_API_KEY` | — | Comma-separated key list: `key1,key2,key3`. Single key = existing behavior. |
| `OPENCODE_THROTTLE_ENABLE` | `"true"` | Set to `"false"` to disable throttle check entirely. |
| `OPENCODE_THROTTLE_DURATION` | `"120"` | Throttle window in minutes. |
| `OPENCODE_WELAN_LOG` | `"true"` | Set to `"false"` to disable welan.txt output. |

---

## Component: ThrottleStore

**File**: `packages/opencode/src/provider/throttle-store.ts`  
**Dependencies**: Node.js `fs/promises`, existing `Flock` utility, `Global.Path.config`

### throttle.json format

```json
[
  {
    "source": "OPENCODE_API_KEY",
    "key": "sk-abc123...",
    "startTime": 1720513264000,
    "endTime":   1720520464000
  }
]
```

`source` holds the env var name, enabling future extension to other providers without schema changes.

### API

```typescript
function isThrottled(source: string, key: string): Promise<boolean>
// Lockless read.
// → true  if record exists AND now < endTime
// → false if record not found
// → false if record exists but now >= endTime (triggers async cleanExpired, non-blocking)
// → false on any read error (prefer false positive to blocking API calls)

function addThrottle(source: string, key: string, durationMinutes: number): Promise<void>
// Flock → re-read → upsert → write → release.
// On timeout (2s): silently return. Never blocks caller beyond 2s.

function cleanExpired(source: string, key: string): Promise<void>
// Flock → re-read → remove expired entries for key → write → release.
```

### Locking strategy

Uses existing `Flock.acquire("throttle-store", { dir: Global.Path.config, timeoutMs: 2_000, staleMs: 10_000 })`.

- **Reads**: no lock — a stale read at worst causes one extra API call that also rate-limits, which then updates the file.
- **Writes**: Flock handles crash recovery via heartbeat + stale detection (no orphaned locks on process crash).
- **Timeout**: 2 s; on timeout `addThrottle` returns without writing. Principle: *prefer more API calls over fewer*.

---

## Component: KeyRotator

**File**: `packages/opencode/src/provider/key-rotator.ts`  
**Dependencies**: `ThrottleStore`, `RotationLogger`, env vars only — no Effect, no Provider internals.

### API

```typescript
function parseKeys(): string[]
// OPENCODE_API_KEY="key1,key2,key3" → ["key1", "key2", "key3"]
// Trims, de-duplicates, drops empty strings.

class KeyRotator {
  constructor(keys: string[])

  // Returns first key not in invalid set and not throttled.
  // Returns null if all keys are exhausted.
  async selectKey(): Promise<string | null>

  // Writes throttle record for key. Async, non-blocking.
  async recordThrottle(key: string): Promise<void>

  // Marks key as invalid for this process lifetime. Does not write throttle.json.
  markInvalid(key: string): void

  // Returns true if any key other than currentKey is not invalid.
  hasAlternative(currentKey: string): boolean
}
```

### `selectKey()` algorithm

```
for key in this.keys:
  if key in this.invalid → skip
  if OPENCODE_THROTTLE_ENABLE !== "false":
    if await ThrottleStore.isThrottled("OPENCODE_API_KEY", key) → log, skip
  return key
return null
```

### Key masking in logs

Last 6 characters only: `***abc123`. Balances debuggability with security.

---

## Component: RotationLogger

**File**: `packages/opencode/src/provider/rotation-logger.ts`
**Dependencies**: Node.js `fs/promises`, `Global.Path.config` — no Effect.

```typescript
type Level = "info" | "warn" | "error"

function log(level: Level, message: string): void
// Fire-and-forget fs.appendFile to ~/.config/opencode/welan-log.txt.
// Also appends the same event to opencode.log using the existing structured log format.
// No-op if OPENCODE_WELAN_LOG === "false".
// Errors silently swallowed (never block API calls).
```

Example log lines:
```
[2026-07-09T18:41:04+08:00] [INFO] key-rotation: start, 3 keys configured
[2026-07-09T18:41:04+08:00] [INFO] key-rotation: attempt 1/3 with key ***abc123
[2026-07-09T18:41:09+08:00] [WARN] key-rotation: key ***abc123 quota_limit, throttle until 2026-07-09T20:41:09+08:00
[2026-07-09T18:41:09+08:00] [INFO] key-rotation: attempt 2/3 with key ***xyz456
[2026-07-09T18:41:15+08:00] [INFO] key-rotation: succeeded with key ***xyz456
```

**Relationship with existing Effect Logger**: Inside the Effect program, existing `Effect.logInfo/logWarn` calls write to `opencode.log` as before. RotationLogger is called from outside the Effect boundary, so it appends matching structured lines to `opencode.log` directly and mirrors to stderr when `OPENCODE_PRINT_LOGS=1`.

---

## Component: run.ts integration

### New function in retry.ts

```typescript
// ~5 lines, mirrors isQuotaOrRateLimitAPIError
export function isInvalidKeyAPIError(error: unknown): boolean
// → true if error.name === "APIError" && error.data.statusCode === 401
```

### KeyRotationRetry signal

`execute(sdk)` keeps its existing return shape. Only key-rotation-worthy errors throw a private signal:

```typescript
class KeyRotationRetry extends Error {
  constructor(
    readonly reason: "quota_limit" | "invalid_key",
    readonly sessionID: string,
    readonly detail?: string,
  )
}
```

| Trigger | `reason` | Write throttle? | Try next key? |
|---|---|---|---|
| `isQuotaOrRateLimitAPIError` | `quota_limit` | ✅ | ✅ |
| `isQuotaOrRateLimitRetryStatus` | `quota_limit` | ✅ | ✅ |
| `isInvalidKeyAPIError` (401) | `invalid_key` | ❌ | ✅ |
| session idle | none | — | — |
| other error | none | — | — |

### Outer rotation loop (new `runWithKeyRotation`)

```typescript
async function runWithKeyRotation(args: RunArgs): Promise<string | undefined> {
  const keys = KeyRotator.parseKeys()
  const rotator = new KeyRotator(keys)
  let sessionID: string | undefined = args.session
  RotationLogger.log("info", `start, ${keys.length} key(s) configured`)

  while (true) {
    const key = await rotator.selectKey()
    if (!key) {
      RotationLogger.log("error", "all OPENCODE_API_KEY keys exhausted or throttled")
      break
    }

    process.env.OPENCODE_API_KEY = key
    RotationLogger.log("info", `attempt with key ***${key.slice(-6)}`)

    try {
      await runAttempt({ ...args, session: sessionID })
      return undefined
    } catch (error) {
      if (!(error instanceof KeyRotationRetry)) throw error
      sessionID = error.sessionID
      if (error.reason === "quota_limit") {
        await rotator.recordThrottle(key)
        if (!rotator.hasAlternative(key)) return error.detail
        RotationLogger.log("warn", `key ***${key.slice(-6)} throttled, trying next`)
        continue
      }

      rotator.markInvalid(key)
      if (!rotator.hasAlternative(key)) return error.detail
      RotationLogger.log("warn", `key ***${key.slice(-6)} invalid, trying next`)
      continue
    }
  }
  return undefined
}
```

The `effectCmd` handler becomes:

```typescript
handler: Effect.fn("Cli.run")(function*(args) {
  // ... existing layer setup (unchanged) ...
  yield* Effect.promise(() => runWithKeyRotation(parsedArgs))
})
```

### Per-attempt local cache reset

Each retry keeps the existing embedded-server process but resets only the local state needed for a new key:

- **InstanceState for the current directory is disposed** so Provider/Env state is rebuilt.
- **Embedded server lazy handler is reset** so subsequent local fetches use the refreshed state.
- **SQLite DB persists** on disk — session messages and history survive.
- **Session ID threading** — first attempt creates session S; subsequent attempts pass S explicitly, triggering V2 exact-retry semantics so history is available.

---

## Behavior Summary

| Scenario | Behavior |
|---|---|
| Key in throttle.json, window active | `selectKey()` skips; no API call made |
| Key in throttle.json, window expired | Record cleaned; key used normally |
| Key returns 429 at runtime | Throttle recorded; next key tried |
| Key returns 401 at runtime | Key marked invalid in-process only; next key tried |
| All keys exhausted | Last error returned; exit nonzero |
| Single key configured | Throttle pre-check and throttle write still apply; no key rotation (no alternatives) |
| `OPENCODE_THROTTLE_ENABLE=false` | Throttle file reads/writes skipped; multi-key invalid-key fallback still active |

---

## Testing Strategy

### Unit tests

**`throttle-store.test.ts`** — pure async, temp dir, no Effect:
- `isThrottled`: absent → false; active → true; expired → false + async cleanup
- `addThrottle`: creates file; upserts existing; handles concurrent access via Flock
- Stale lock: simulate stale (delete heartbeat); verify next caller acquires successfully

**`key-rotator.test.ts`** — pure async, mock `ThrottleStore.isThrottled`:
- `parseKeys`: single key, multi-key, empty, whitespace trimming, dedup
- `selectKey`: first available; skips invalid; skips throttled; null when all exhausted
- `recordThrottle`: calls `addThrottle` with correct `source` and `durationMinutes`
- `markInvalid`: skips key in subsequent calls; does not write throttle.json
- `hasAlternative`: true when non-invalid alternatives exist; false when all invalid

### End-to-end tests

**`run-key-rotation.test.ts`** — extends `cliIt.live` pattern:
- **Throttle pre-check**: seed `throttle.json` with active record for key1; verify key2 used.
- **Quota fallback**: key1 returns 429; verify key2 tried; verify `throttle.json` updated.
- **Invalid key fallback**: key1 returns 401; verify key2 tried; no throttle record written.
- **All keys exhausted**: both keys throttled; verify exit nonzero; zero API calls made.
- **Single key fast path**: verify no overhead when `OPENCODE_API_KEY` has one value.
- **Session continuity**: key1 429 creates session S; key2 reuses session S; history present.

---

## Cherry-Pick Constraints

- `throttle-store.ts`, `key-rotator.ts`, `rotation-logger.ts` — **new files, zero imports from Provider/Session/Effect layers**.
- `run.ts` — outer loop is a **new function** `runWithKeyRotation`; existing `execute()` keeps its return shape and only throws `KeyRotationRetry` for rotation-worthy errors.
- `retry.ts` — adds one function `isInvalidKeyAPIError`; no existing functions modified.
- rotation log appends are fire-and-forget; failures are silently swallowed.
- `OPENCODE_THROTTLE_ENABLE=false`: throttle file reads/writes are bypassed; the rotation loop itself still runs for multi-key invalid-key fallback.
