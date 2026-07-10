import { afterEach, expect, test } from "bun:test"
import { keyRotationRetry } from "../../../src/provider/key-rotation-retry"
import { runWithKeyRotation } from "../../../src/cli/cmd/run/key-rotation"

const env = {
  apiKey: process.env.OPENCODE_API_KEY,
  rotationActive: process.env.OPENCODE_KEY_ROTATION_ACTIVE,
  welanLog: process.env.OPENCODE_WELAN_LOG,
  exitCode: process.exitCode,
}

afterEach(() => {
  if (env.apiKey === undefined) delete process.env.OPENCODE_API_KEY
  else process.env.OPENCODE_API_KEY = env.apiKey
  if (env.rotationActive === undefined) delete process.env.OPENCODE_KEY_ROTATION_ACTIVE
  else process.env.OPENCODE_KEY_ROTATION_ACTIVE = env.rotationActive
  if (env.welanLog === undefined) delete process.env.OPENCODE_WELAN_LOG
  else process.env.OPENCODE_WELAN_LOG = env.welanLog
  process.exitCode = env.exitCode
})

test("runs the next key after an invalid-key rotation signal", async () => {
  process.env.OPENCODE_API_KEY = "key1,key2"
  process.env.OPENCODE_WELAN_LOG = "false"
  const attempted: string[] = []
  let resets = 0

  await runWithKeyRotation({
    createSdk: () => undefined,
    execute: async () => {
      attempted.push(process.env.OPENCODE_API_KEY ?? "")
      if (attempted.length === 1) throw keyRotationRetry("invalid_key")
    },
    reset: async () => {
      resets++
    },
    onExhausted: () => {},
  })

  expect(attempted).toEqual(["key1", "key2"])
  expect(resets).toBe(1)
})

test("reports the final invalid-key signal", async () => {
  process.env.OPENCODE_API_KEY = "key1,key2"
  process.env.OPENCODE_WELAN_LOG = "false"
  let exhausted: ReturnType<typeof keyRotationRetry> | undefined

  await runWithKeyRotation({
    createSdk: () => undefined,
    execute: async () => {
      throw keyRotationRetry("invalid_key", "key2 is invalid")
    },
    reset: async () => {},
    onExhausted: (error) => {
      exhausted = error
    },
  })

  expect(exhausted).toMatchObject({ reason: "invalid_key", message: "key2 is invalid" })
})
