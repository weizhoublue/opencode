export type RotateReason = "quota_limit" | "invalid_key"

const TAG = Symbol.for("opencode.KeyRotationRetry")

export type KeyRotationRetry = {
  readonly [TAG]: true
  readonly reason: RotateReason
  readonly message?: string
}

export function keyRotationRetry(reason: RotateReason, message?: string): KeyRotationRetry {
  return { [TAG]: true, reason, message }
}

export function isKeyRotationRetry(value: unknown): value is KeyRotationRetry {
  return typeof value === "object" && value !== null && TAG in value
}
