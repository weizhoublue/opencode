import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { createRotationLogger } from "../../src/provider/rotation-logger"

const tmpDir = path.join(os.tmpdir(), "opencode-welan-test-" + process.pid)
const configDir = path.join(tmpDir, "xdg", "opencode")
const logDir = path.join(tmpDir, "log")
const welanFile = path.join(configDir, "welan-log.txt")
const opencodeLogFile = path.join(logDir, "opencode.log")
const rotationLogger = createRotationLogger({ configDir, logDir })

beforeEach(async () => {
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(logDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.OPENCODE_WELAN_LOG
  delete process.env.OPENCODE_PRINT_LOGS
})

describe("RotationLogger.log", () => {
  it("appends a line to welan.txt with correct format", async () => {
    rotationLogger.log("info", "test message")
    const content = await fs.readFile(welanFile, "utf8")
    expect(content).toMatch(/\[.*\] \[.*\] \[INFO\] test message\n/)
  })

  it("appends multiple lines in order", async () => {
    rotationLogger.log("info", "first")
    rotationLogger.log("warn", "second")
    const content = await fs.readFile(welanFile, "utf8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("[INFO] first")
    expect(lines[1]).toContain("[WARN] second")
    const prefix = lines[0].split("] [")[0].slice(1)
    expect(lines[1].startsWith(`[${prefix}]`)).toBe(true)
  })

  it("also writes to the regular opencode log format", async () => {
    rotationLogger.log("warn", "regular log message")
    const content = await fs.readFile(opencodeLogFile, "utf8")
    expect(content).toContain("level=WARN")
    expect(content).toMatch(/run=[^\s]+/)
    expect(content).toContain('message="key-rotation: regular log message"')
  })

  it("does nothing when OPENCODE_WELAN_LOG=false", async () => {
    process.env.OPENCODE_WELAN_LOG = "false"
    rotationLogger.log("info", "should not appear")
    const exists = await fs
      .stat(welanFile)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("writes to stderr immediately when OPENCODE_PRINT_LOGS=1", () => {
    process.env.OPENCODE_PRINT_LOGS = "1"
    const chunks: string[] = []
    const original = process.stderr.write
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      rotationLogger.log("error", "key-rotation: immediate stderr")
      expect(chunks.join("")).toContain("level=ERROR")
      expect(chunks.join("")).toContain("key-rotation: immediate stderr")
    } finally {
      process.stderr.write = original
    }
  })
})
