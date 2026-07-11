import path from "path"
import fs from "fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"

type ThrottleRecord = {
  source: string
  key_hint: string
  key_hash: string
  startTime: string
  endTime: string
}

function formatLocalTime(time: number) {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

function isExpired(record: ThrottleRecord, now: number) {
  const endTime = Date.parse(record.endTime)
  return Number.isNaN(endTime) || now >= endTime
}

type StoreOptions = {
  configDir: string | (() => string)
}

async function hashKey(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createThrottleStore(options: StoreOptions) {
  const configDir = () => (typeof options.configDir === "string" ? options.configDir : options.configDir())
  const filePath = () => path.join(configDir(), "throttle.json")

  async function readRecords(): Promise<ThrottleRecord[]> {
    try {
      const raw = await fs.readFile(filePath(), "utf8")
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed as ThrottleRecord[]
    } catch {
      return []
    }
  }

  async function writeRecords(records: ThrottleRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath()), { recursive: true })
    await fs.writeFile(filePath(), JSON.stringify(records, null, 2))
  }

  async function isThrottled(source: string, key: string): Promise<boolean> {
    const records = await readRecords()
    const now = Date.now()
    const keyHash = await hashKey(key)
    const record = records.find((r) => r.source === source && r.key_hash === keyHash)
    if (!record) return false
    if (!isExpired(record, now)) return true
    await cleanExpired(source, key)
    return false
  }

  async function addThrottle(source: string, key: string, durationMinutes: number): Promise<void> {
    let lease: Awaited<ReturnType<typeof Flock.acquire>> | null = null
    try {
      lease = await Flock.acquire("throttle-store", {
        dir: configDir(),
        timeoutMs: 2_000,
        staleMs: 10_000,
      })
    } catch {
      return
    }
    try {
      const records = await readRecords()
      const now = Date.now()
      const endTime = now + durationMinutes * 60 * 1000
      const keyHash = await hashKey(key)
      const idx = records.findIndex((r) => r.source === source && r.key_hash === keyHash)
      const record: ThrottleRecord = {
        source,
        key_hint: `***${key.slice(-8)}`,
        key_hash: keyHash,
        startTime: formatLocalTime(now),
        endTime: formatLocalTime(endTime),
      }
      if (idx >= 0) records[idx] = record
      else records.push(record)
      await writeRecords(records)
    } finally {
      await lease.release()
    }
  }

  async function cleanExpired(source: string, key: string): Promise<void> {
    let lease: Awaited<ReturnType<typeof Flock.acquire>> | null = null
    try {
      lease = await Flock.acquire("throttle-store", {
        dir: configDir(),
        timeoutMs: 2_000,
        staleMs: 10_000,
      })
    } catch {
      return
    }
    try {
      const records = await readRecords()
      const now = Date.now()
      const keyHash = await hashKey(key)
      const filtered = records.filter((r) => !(r.source === source && r.key_hash === keyHash && isExpired(r, now)))
      await writeRecords(filtered)
    } finally {
      await lease.release()
    }
  }

  return { isThrottled, addThrottle, cleanExpired }
}

const store = createThrottleStore({ configDir: () => Global.Path.config })

export const isThrottled = store.isThrottled
export const addThrottle = store.addThrottle
export const cleanExpired = store.cleanExpired

export * as ThrottleStore from "./throttle-store"
