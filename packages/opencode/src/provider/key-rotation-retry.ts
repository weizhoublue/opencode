export type RotateReason = "quota_limit" | "invalid_key"

const TAG = Symbol.for("opencode.KeyRotationRetry")

export type KeyRotationRetry = {
  readonly [TAG]: true
  readonly reason: RotateReason
}

export function keyRotationRetry(reason: RotateReason): KeyRotationRetry {
  return { [TAG]: true, reason }
}

export function isKeyRotationRetry(value: unknown): value is KeyRotationRetry {
  return typeof value === "object" && value !== null && TAG in value
}
