import { describe, expect, it } from "bun:test"
import { isKeyRotationRetry, keyRotationRetry } from "../../src/provider/key-rotation-retry"

describe("KeyRotationRetry", () => {
  it("carries reason", () => {
    const error = keyRotationRetry("quota_limit")
    expect(isKeyRotationRetry(error)).toBe(true)
    expect(error.reason).toBe("quota_limit")
  })
})
