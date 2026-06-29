#!/usr/bin/env bun

import path from "path"
import { ZEN_LIMIT_ERROR_TYPES } from "../src/session/retry.ts"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const handlerPath = path.join(repoRoot, "packages/console/app/src/routes/zen/util/handler.ts")
const errorPath = path.join(repoRoot, "packages/console/app/src/routes/zen/util/error.ts")

function sorted(values: readonly string[]) {
  return [...values].sort()
}

function same(left: readonly string[], right: readonly string[]) {
  return left.join("\0") === right.join("\0")
}

function handlerLimitTypes(source: string) {
  const match = source.match(
    /if \(\s*\n\s*error instanceof RateLimitError[\s\S]*?error instanceof BlackUsageLimitError\s*\)/,
  )
  if (!match) {
    throw new Error(`Could not find zen handler 429 limit instanceof block in ${handlerPath}`)
  }

  return sorted([...match[0].matchAll(/error instanceof (\w+)/g)].map((item) => item[1]))
}

function errorLimitTypes(source: string) {
  return sorted([...source.matchAll(/^export class (\w+) extends LimitError/gm)].map((item) => item[1]))
}

function report(label: string, values: readonly string[]) {
  console.error(`  ${label}: ${values.join(", ") || "(empty)"}`)
}

function fail(message: string, details: Record<string, readonly string[]>) {
  console.error(`check-zen-limit-sync: ${message}`)
  for (const [label, values] of Object.entries(details)) {
    report(label, values)
  }
  process.exit(1)
}

const handlerSource = await Bun.file(handlerPath).text()
const errorSource = await Bun.file(errorPath).text()

const retryTypes = sorted(ZEN_LIMIT_ERROR_TYPES)
const handlerTypes = handlerLimitTypes(handlerSource)
const errorTypes = errorLimitTypes(errorSource)

if (!same(retryTypes, handlerTypes)) {
  fail("ZEN_LIMIT_ERROR_TYPES is out of sync with handler.ts 429 instanceof block", {
    retry: retryTypes,
    handler: handlerTypes,
  })
}

if (!same(retryTypes, errorTypes)) {
  fail("ZEN_LIMIT_ERROR_TYPES is out of sync with error.ts LimitError exports", {
    retry: retryTypes,
    error: errorTypes,
  })
}

console.log(`check-zen-limit-sync: OK (${retryTypes.join(", ")})`)
