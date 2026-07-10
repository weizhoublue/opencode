import { describe, expect, it } from "bun:test"
import { KeyRotationRetry } from "../../src/provider/key-rotation-retry"

describe("KeyRotationRetry", () => {
  it("carries reason", () => {
    const error = new KeyRotationRetry("quota_limit")
    expect(error).toBeInstanceOf(KeyRotationRetry)
    expect(error).toBeInstanceOf(Error)
    expect(error.reason).toBe("quota_limit")
    expect(error.name).toBe("KeyRotationRetry")
  })
})
