import { afterEach, describe, expect, it, mock } from "bun:test"
import { KeyRotator, parseKeys } from "../../src/provider/key-rotator"

const mockIsThrottled = mock(async (_source: string, _key: string) => false)
const mockAddThrottle = mock(async (_source: string, _key: string, _dur: number) => {})

const store = { isThrottled: mockIsThrottled, addThrottle: mockAddThrottle }

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

describe("KeyRotator.parseKeys", () => {
  it("exposes parseKeys function on the KeyRotator namespace", () => {
    expect(KeyRotator.parseKeys).toBe(parseKeys)
    process.env.OPENCODE_API_KEY = "sk-abc,sk-def"
    expect(KeyRotator.parseKeys()).toEqual(["sk-abc", "sk-def"])
  })
})

describe("KeyRotator.selectKey", () => {
  it("returns first key when none are throttled or invalid", async () => {
    const r = new KeyRotator(["key1", "key2"], store)
    expect(await r.selectKey()).toBe("key1")
  })

  it("skips throttled key and returns next", async () => {
    mockIsThrottled.mockImplementation(async (_s, key) => key === "key1")
    const r = new KeyRotator(["key1", "key2"], store)
    expect(await r.selectKey()).toBe("key2")
  })

  it("skips invalid key and returns next", async () => {
    const r = new KeyRotator(["key1", "key2"], store)
    r.markInvalid("key1")
    expect(await r.selectKey()).toBe("key2")
  })

  it("returns null when all keys are throttled", async () => {
    mockIsThrottled.mockImplementation(async () => true)
    const r = new KeyRotator(["key1", "key2"], store)
    expect(await r.selectKey()).toBeNull()
  })

  it("returns null when all keys are invalid", async () => {
    const r = new KeyRotator(["key1", "key2"], store)
    r.markInvalid("key1")
    r.markInvalid("key2")
    expect(await r.selectKey()).toBeNull()
  })

  it("skips throttle check when OPENCODE_THROTTLE_ENABLE=false", async () => {
    process.env.OPENCODE_THROTTLE_ENABLE = "false"
    mockIsThrottled.mockImplementation(async () => true) // would throttle if checked
    const r = new KeyRotator(["key1"], store)
    expect(await r.selectKey()).toBe("key1") // not skipped because throttle disabled
    expect(mockIsThrottled).not.toHaveBeenCalled()
  })
})

describe("KeyRotator.recordThrottle", () => {
  it("calls ThrottleStore.addThrottle with correct source and default duration", async () => {
    const r = new KeyRotator(["key1"], store)
    await r.recordThrottle("key1")
    expect(mockAddThrottle).toHaveBeenCalledWith("OPENCODE_API_KEY", "key1", 120)
  })

  it("uses OPENCODE_THROTTLE_DURATION when set", async () => {
    process.env.OPENCODE_THROTTLE_DURATION = "60"
    const r = new KeyRotator(["key1"], store)
    await r.recordThrottle("key1")
    expect(mockAddThrottle).toHaveBeenCalledWith("OPENCODE_API_KEY", "key1", 60)
  })
})

describe("KeyRotator.markInvalid", () => {
  it("causes the key to be skipped in selectKey", async () => {
    const r = new KeyRotator(["key1", "key2"], store)
    r.markInvalid("key1")
    expect(await r.selectKey()).toBe("key2")
  })

  it("does not write to throttle.json", async () => {
    const r = new KeyRotator(["key1"], store)
    r.markInvalid("key1")
    expect(mockAddThrottle).not.toHaveBeenCalled()
  })
})

describe("KeyRotator.hasAlternative", () => {
  it("returns true when other non-invalid keys exist", () => {
    const r = new KeyRotator(["key1", "key2", "key3"], store)
    expect(r.hasAlternative("key1")).toBe(true)
  })

  it("returns false when only one key and it is current", () => {
    const r = new KeyRotator(["key1"], store)
    expect(r.hasAlternative("key1")).toBe(false)
  })

  it("returns false when other keys are all invalid", () => {
    const r = new KeyRotator(["key1", "key2"], store)
    r.markInvalid("key2")
    expect(r.hasAlternative("key1")).toBe(false)
  })
})
