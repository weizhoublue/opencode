import { isKeyRotationRetry } from "@/provider/key-rotation-retry"
import { KeyRotator, parseKeys } from "@/provider/key-rotator"
import { RotationLogger } from "@/provider/rotation-logger"

type KeyRotationOptions<T> = {
  createSdk: () => T
  execute: (sdk: T) => Promise<void>
  reset: () => Promise<void>
}

export async function runWithKeyRotation<T>(options: KeyRotationOptions<T>): Promise<void> {
  const keys = parseKeys()
  if (keys.length <= 1) {
    await options.execute(options.createSdk())
    return
  }
  const rotator = new KeyRotator(keys)

  RotationLogger.log("info", `key-rotation: start, ${keys.length} key(s) configured`)

  let attempt = 0
  while (true) {
    const key = await rotator.selectKey()
    if (!key) {
      RotationLogger.log("error", "key-rotation: all OPENCODE_API_KEY keys exhausted or throttled")
      process.exitCode = 1
      return
    }

    attempt++
    process.env.OPENCODE_API_KEY = key
    if (attempt > 1) await options.reset()
    RotationLogger.log("info", `key-rotation: attempt ${attempt} with key ***${key.slice(-6)}`)

    const previousRotationActive = process.env.OPENCODE_KEY_ROTATION_ACTIVE
    process.env.OPENCODE_KEY_ROTATION_ACTIVE = "true"
    try {
      try {
        await options.execute(options.createSdk())
      } catch (error) {
        if (!isKeyRotationRetry(error)) throw error
        if (error.reason === "quota_limit") {
          await rotator.recordThrottle(key)
          RotationLogger.log(
            "error",
            `key-rotation: key ***${key.slice(-6)} quota_limit, ${rotator.hasAlternative(key) ? "trying next" : "no more keys"}`,
          )
          if (!rotator.hasAlternative(key)) {
            process.exitCode = 1
            return
          }
          process.exitCode = 0
          continue
        }
        rotator.markInvalid(key)
        RotationLogger.log(
          "error",
          `key-rotation: key ***${key.slice(-6)} invalid, ${rotator.hasAlternative(key) ? "trying next" : "no more keys"}`,
        )
        if (!rotator.hasAlternative(key)) {
          process.exitCode = 1
          return
        }
        process.exitCode = 0
        continue
      }
      if (process.exitCode) return
      RotationLogger.log("info", `key-rotation: success with key ***${key.slice(-6)}`)
      return
    } finally {
      if (previousRotationActive === undefined) delete process.env.OPENCODE_KEY_ROTATION_ACTIVE
      else process.env.OPENCODE_KEY_ROTATION_ACTIVE = previousRotationActive
    }
  }
}
