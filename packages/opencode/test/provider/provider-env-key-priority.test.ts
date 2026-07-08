/**
 * Tests for env var API key priority over stored (UI-configured) keys.
 *
 * These tests live in a separate file to minimize merge conflicts with
 * the upstream provider.test.ts.
 */
import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances } from "../fixture/fixture"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const remove = (k: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    delete process.env[k]
    yield* Env.use.remove(k)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, Auth.node])))

const list = Provider.use.list()

// ── Case 1: regression ─────────────────────────────────────────────────────
// When no env var is set, a stored API key should still be used.
it.instance("stored key is used when no env var is set", () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("anthropic", { type: "api", key: "stored-only-key" })
    yield* Effect.addFinalizer(() => auth.remove("anthropic").pipe(Effect.orDie))

    yield* remove("ANTHROPIC_API_KEY")

    const providers = yield* list
    const anthropic = providers[ProviderV2.ID.anthropic]
    expect(anthropic).toBeDefined()
    expect(anthropic.key).toBe("stored-only-key")
    expect(anthropic.source).toBe("api")
  }),
)

// ── Case 2: opencode provider ───────────────────────────────────────────────
// OPENCODE_API_KEY env var should take precedence over a stored opencode key.
// This is the primary use-case: switch keys at launch without touching stored config.
it.instance("OPENCODE_API_KEY env var takes precedence over stored opencode key", () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("opencode", { type: "api", key: "stored-opencode-key" })
    yield* Effect.addFinalizer(() => auth.remove("opencode").pipe(Effect.orDie))

    yield* set("OPENCODE_API_KEY", "env-opencode-key")

    const providers = yield* list
    const opencode = providers[ProviderV2.ID.opencode]
    expect(opencode).toBeDefined()
    expect(opencode.key).toBe("env-opencode-key")
    expect(opencode.source).toBe("env")
  }),
)

// ── Case 3: independence across providers ──────────────────────────────────
// An env var for one provider must not affect another provider's stored key.
it.instance("env var for one provider does not affect another provider stored key", () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    // anthropic: env var set → should use env
    yield* set("ANTHROPIC_API_KEY", "env-anthropic-key")
    // openai: only stored key, no env var → should use stored
    yield* auth.set("openai", { type: "api", key: "stored-openai-key" })
    yield* Effect.addFinalizer(() => auth.remove("openai").pipe(Effect.orDie))
    yield* remove("OPENAI_API_KEY")

    const providers = yield* list

    const anthropic = providers[ProviderV2.ID.anthropic]
    expect(anthropic).toBeDefined()
    expect(anthropic.key).toBe("env-anthropic-key")
    expect(anthropic.source).toBe("env")

    const openai = providers[ProviderV2.ID.openai]
    expect(openai).toBeDefined()
    expect(openai.key).toBe("stored-openai-key")
    expect(openai.source).toBe("api")
  }),
)
