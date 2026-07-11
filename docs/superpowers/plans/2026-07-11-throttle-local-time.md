# Throttle Local Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store `throttle.json` timestamps as readable local ISO 8601 strings while preserving throttle and expiry behavior.

**Architecture:** `ThrottleStore` formats the two calculated timestamps into local ISO 8601 strings with milliseconds and a numeric UTC offset before persisting. It parses `endTime` when deciding whether a record is active or removable. Test fixtures use the same string representation because numeric timestamp support is deliberately removed.

**Tech Stack:** TypeScript, Bun test runner, Node `fs/promises`, existing `Flock` utility.

## Global Constraints

- Scope is `packages/opencode` throttle persistence and its tests only.
- `startTime` and `endTime` are local ISO 8601 strings with milliseconds and an explicit UTC offset.
- Numeric timestamp compatibility and migration are out of scope.
- Run tests and `bun typecheck` from `packages/opencode`, never from repo root.
- Commit with `git commit -s -S` using a concise conventional one-line message.

---

## File Structure

- Modify `packages/opencode/src/provider/throttle-store.ts`: change the persisted timestamp type, format local values, and parse expiry values.
- Modify `packages/opencode/test/provider/throttle-store.test.ts`: make unit fixtures string-based and verify write format, duration, active state, and expiry cleanup.
- Modify `packages/opencode/test/cli/run/run-key-rotation.test.ts`: replace pre-seeded numeric timestamp fixtures with local ISO 8601 strings.

### Task 1: Persist and consume local ISO timestamps

**Files:**
- Modify: `packages/opencode/test/provider/throttle-store.test.ts`
- Modify: `packages/opencode/test/cli/run/run-key-rotation.test.ts`
- Modify: `packages/opencode/src/provider/throttle-store.ts`

**Interfaces:**
- Consumes: `createThrottleStore({ configDir })` with `isThrottled`, `addThrottle`, and `cleanExpired`.
- Produces: `throttle.json` records whose `startTime` and `endTime` are local ISO 8601 strings, such as `2026-07-11T14:21:02.689+08:00`.

- [x] **Step 1: Write the failing unit and CLI fixture changes**

Add this test helper near `hashKey` in both affected test files, using local date parts and `getTimezoneOffset()` to generate a portable local ISO string:

```typescript
function localTime(time: number) {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}
```

Replace every pre-seeded unit and CLI record timestamp with `localTime(now - 1_000)` or `localTime(now + 60_000)` as appropriate. In the `addThrottle` creation test, replace numeric subtraction with these assertions:

```typescript
expect(data[0].startTime).toMatch(/\.\d{3}[+-]\d{2}:\d{2}$/)
expect(data[0].endTime).toMatch(/\.\d{3}[+-]\d{2}:\d{2}$/)
expect(Date.parse(data[0].endTime) - Date.parse(data[0].startTime)).toBe(120 * 60 * 1000)
```

Apply the same parsed-duration assertion to the upsert test. Add a test that calls `addThrottle(..., -1)` then `isThrottled(...)`, expects `false`, and verifies that the expired record was removed.

- [x] **Step 2: Run the targeted unit test and verify it fails**

Run:

```bash
cd packages/opencode && bun test test/provider/throttle-store.test.ts
```

Expected: FAIL because the production store still writes numbers and compares `now` directly to `record.endTime`.

- [x] **Step 3: Implement the smallest timestamp conversion and parsing change**

Change the record type and add these helpers below it:

```typescript
type ThrottleRecord = {
  source: string
  key_hint: string
  key_hash: string
  startTime: string
  endTime: string
}

function formatLocalTime(time: number) {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

function isExpired(record: ThrottleRecord, now: number) {
  const endTime = Date.parse(record.endTime)
  return Number.isNaN(endTime) || now >= endTime
}
```

In `isThrottled`, replace the numeric comparison with `if (!isExpired(record, now)) return true`. In `addThrottle`, write `startTime: formatLocalTime(now)` and `endTime: formatLocalTime(endTime)`. In `cleanExpired`, replace `now >= r.endTime` with `isExpired(r, now)` in the matching-record predicate so expired and invalid old numeric entries are removed.

- [x] **Step 4: Run focused verification**

Run:

```bash
cd packages/opencode && bun test test/provider/throttle-store.test.ts && bun test test/cli/run/run-key-rotation.test.ts && bun typecheck
```

Expected: all targeted tests pass and `bun typecheck` exits 0.

- [x] **Step 5: Review changed files and commit**

Run:

```bash
git diff --check && git diff -- packages/opencode/src/provider/throttle-store.ts packages/opencode/test/provider/throttle-store.test.ts packages/opencode/test/cli/run/run-key-rotation.test.ts
git add packages/opencode/src/provider/throttle-store.ts packages/opencode/test/provider/throttle-store.test.ts packages/opencode/test/cli/run/run-key-rotation.test.ts
git commit -s -S -m "fix(opencode): store throttle times locally"
```

Expected: no whitespace errors; one signed and signed-off commit containing only the three implementation files.
