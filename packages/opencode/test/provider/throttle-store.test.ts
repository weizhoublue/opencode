import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { createThrottleStore } from "../../src/provider/throttle-store"

const tmpDir = path.join(os.tmpdir(), "opencode-throttle-test-" + process.pid)
const configDir = path.join(tmpDir, "xdg", "opencode")
const throttleFile = path.join(configDir, "throttle.json")
const throttleStore = createThrottleStore({ configDir })

beforeEach(async () => {
  await fs.mkdir(configDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("ThrottleStore.isThrottled", () => {
  it("returns false when throttle.json does not exist", async () => {
    expect(await throttleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
  })

  it("returns true when key has an active throttle record", async () => {
    const now = Date.now()
    await fs.writeFile(
      throttleFile,
      JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 60_000 }]),
    )
    expect(await throttleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(true)
  })

  it("returns false when key record is expired", async () => {
    const now = Date.now()
    await fs.writeFile(
      throttleFile,
      JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 120_000, endTime: now - 1000 }]),
    )
    expect(await throttleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
  })

  it("returns false for a different key not in the file", async () => {
    const now = Date.now()
    await fs.writeFile(
      throttleFile,
      JSON.stringify([{ source: "OPENCODE_API_KEY", key: "key1", startTime: now - 1000, endTime: now + 60_000 }]),
    )
    expect(await throttleStore.isThrottled("OPENCODE_API_KEY", "key2")).toBe(false)
  })

  it("returns false on JSON parse error (file is corrupt)", async () => {
    await fs.writeFile(throttleFile, "not-json")
    expect(await throttleStore.isThrottled("OPENCODE_API_KEY", "key1")).toBe(false)
  })
})

describe("ThrottleStore.addThrottle", () => {
  it("creates throttle.json with a new record", async () => {
    await throttleStore.addThrottle("OPENCODE_API_KEY", "key1", 120)
    const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
    expect(data).toHaveLength(1)
    expect(data[0].source).toBe("OPENCODE_API_KEY")
    expect(data[0].key).toBe("key1")
    expect(data[0].endTime - data[0].startTime).toBe(120 * 60 * 1000)
  })

  it("upserts: updates existing record for same key", async () => {
    await throttleStore.addThrottle("OPENCODE_API_KEY", "key1", 60)
    await throttleStore.addThrottle("OPENCODE_API_KEY", "key1", 120)
    const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
    expect(data).toHaveLength(1)
    expect(data[0].endTime - data[0].startTime).toBe(120 * 60 * 1000)
  })

  it("appends: keeps other keys when adding a new one", async () => {
    await throttleStore.addThrottle("OPENCODE_API_KEY", "key1", 60)
    await throttleStore.addThrottle("OPENCODE_API_KEY", "key2", 120)
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
    await throttleStore.cleanExpired("OPENCODE_API_KEY", "key1")
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
    await throttleStore.cleanExpired("OPENCODE_API_KEY", "key1")
    const data = JSON.parse(await fs.readFile(throttleFile, "utf8"))
    expect(data).toHaveLength(1)
  })
})
