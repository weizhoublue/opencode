import { ThrottleStore } from "./throttle-store"
import { RotationLogger } from "./rotation-logger"

const SOURCE = "OPENCODE_API_KEY"
type KeyRotatorStore = Pick<typeof ThrottleStore, "isThrottled" | "addThrottle">

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

  constructor(
    private readonly keys: string[],
    private readonly store: KeyRotatorStore = ThrottleStore,
  ) {}

  async selectKey(): Promise<string | null> {
    for (const key of this.keys) {
      if (this.invalid.has(key)) continue
      if (isThrottleEnabled() && (await this.store.isThrottled(SOURCE, key))) {
        RotationLogger.log("info", `key-rotation: key ${maskKey(key)} is throttled, skipping`)
        continue
      }
      return key
    }
    return null
  }

  async recordThrottle(key: string): Promise<void> {
    if (!isThrottleEnabled()) return
    const duration = throttleDuration()
    RotationLogger.log(
      "error",
      `key-rotation: key ${maskKey(key)} throttled for ${duration} minutes, writing throttle record`,
    )
    await this.store.addThrottle(SOURCE, key, duration)
  }

  markInvalid(key: string): void {
    RotationLogger.log("error", `key-rotation: key ${maskKey(key)} marked invalid, skipping for this process`)
    this.invalid.add(key)
  }

  hasAlternative(currentKey: string): boolean {
    return this.keys.some((k) => k !== currentKey && !this.invalid.has(k))
  }
}

const _parseKeys = parseKeys

export namespace KeyRotator {
  export const parseKeys = _parseKeys
}
