export type RotateReason = "quota_limit" | "invalid_key"

export class KeyRotationRetry extends Error {
  override readonly name = "KeyRotationRetry"

  constructor(readonly reason: RotateReason) {
    super(`key rotation: ${reason}`)
  }
}
