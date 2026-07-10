import path from "path"
import fs from "fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"

type ThrottleRecord = {
  source: string
  key: string
  startTime: number
  endTime: number
}

type StoreOptions = {
  configDir: string | (() => string)
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
    const record = records.find((r) => r.source === source && r.key === key)
    if (!record) return false
    if (now < record.endTime) return true
    void cleanExpired(source, key)
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
      const idx = records.findIndex((r) => r.source === source && r.key === key)
      const record: ThrottleRecord = { source, key, startTime: now, endTime }
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
      const filtered = records.filter((r) => !(r.source === source && r.key === key && now >= r.endTime))
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
