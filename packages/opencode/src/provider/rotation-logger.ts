import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { runID } from "@opencode-ai/core/observability/shared"

export type Level = "info" | "warn" | "error"

const PID_PREFIX = new Date().toISOString().slice(11, 23).replace(/[:.]/g, "") // e.g. "012300000Z"

type LoggerOptions = {
  configDir: string | (() => string)
  logDir: string | (() => string)
}

export function createRotationLogger(options: LoggerOptions) {
  const configDir = () => (typeof options.configDir === "string" ? options.configDir : options.configDir())
  const logDir = () => (typeof options.logDir === "string" ? options.logDir : options.logDir())
  const filePath = () => path.join(configDir(), "welan-log.txt")
  const regularLogPath = () => path.join(logDir(), "opencode.log")
  let writeChain = Promise.resolve()

  function log(level: Level, message: string): void {
    if (process.env.OPENCODE_WELAN_LOG === "false") return
    const now = new Date()
    const timestamp =
      now.toLocaleString("sv-SE", { hour12: false }).replace(" ", "T") +
      "." +
      String(now.getMilliseconds()).padStart(3, "0")
    const line = `[${PID_PREFIX}] [${timestamp}] [${level.toUpperCase()}] ${message}\n`
    const regularLine = regularLogLine(
      level,
      message.startsWith("key-rotation:") ? message : `key-rotation: ${message}`,
      now,
    )
    writeChain = writeChain
      .then(() => fs.mkdir(path.dirname(filePath()), { recursive: true }))
      .then(() => fs.appendFile(filePath(), line))
      .then(() => fs.mkdir(path.dirname(regularLogPath()), { recursive: true }))
      .then(() => fs.appendFile(regularLogPath(), regularLine))
      .then(() => {
        if (process.env.OPENCODE_PRINT_LOGS === "1") process.stderr.write(regularLine)
      })
      .catch(() => {})
  }

  return { log }
}

function regularLogLine(level: Level, message: string, timestamp: Date) {
  return `timestamp=${timestamp.toISOString()} level=${level.toUpperCase()} run=${runID} message=${formatLogValue(message)}\n`
}

function formatLogValue(value: string) {
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

const logger = createRotationLogger({
  configDir: () => Global.Path.config,
  logDir: () => Global.Path.log,
})

export const log = logger.log

export * as RotationLogger from "./rotation-logger"
