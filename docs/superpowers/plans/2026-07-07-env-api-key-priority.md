# Env Var API Key Priority Over Stored Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make environment variable API keys (e.g. `OPENCODE_API_KEY`) take precedence over API keys stored via the interactive UI, so users can switch keys at launch time without touching stored configuration.

**Architecture:** In the provider loading sequence inside `provider.ts`, the `// load apikeys` section currently runs after `// load env` and overwrites whatever env var key was loaded. The fix adds a 2-line guard: before merging a stored API key into a provider, check whether that provider's env vars already provided a key. If so, skip the stored key.

**Tech Stack:** TypeScript, Effect, Bun test runner

## Global Constraints

- Run tests from `packages/opencode`, never from repo root
- Use `bun test` (not `bun run test`) to run tests
- Use `bun typecheck` (not `tsc`) for type checking
- Do not move or restructure code blocks — only add the guard inside the existing loop

---

### Task 1: Write the failing test

**Files:**
- Modify: `packages/opencode/test/provider/provider.test.ts` (append at end of file)

**Interfaces:**
- Consumes: `Auth.Service` (already imported as `import { Auth } from "@/auth"`), `set` helper (already defined at line 36), `Global` from `@opencode-ai/core/global`, `Filesystem` from `@/util/filesystem`
- Produces: test case `"env var takes precedence over stored API key"`

- [ ] **Step 1: Append the new test to the test file**

Open `packages/opencode/test/provider/provider.test.ts` and append at the very end:

```typescript
it.instance("env var takes precedence over stored API key", () =>
  Effect.gen(function* () {
    // Set a stored API key for anthropic
    const auth = yield* Auth.Service
    yield* auth.set("anthropic", { type: "api", key: "stored-key" })

    // Set an env var key — this should win
    yield* set("ANTHROPIC_API_KEY", "env-key")

    const providers = yield* list
    const anthropic = providers[ProviderV2.ID.anthropic]
    expect(anthropic).toBeDefined()
    // The loaded key should be the env var, not the stored key
    expect(anthropic.key).toBe("env-key")
  }),
)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/opencode && bun test test/provider/provider.test.ts --test-name-pattern "env var takes precedence over stored API key"
```

Expected: test **FAILS** — currently `anthropic.key` will be `"stored-key"` (stored key wins over env).

---

### Task 2: Implement the fix

**Files:**
- Modify: `packages/opencode/src/provider/provider.ts:1501-1512`

**Interfaces:**
- Consumes: `database` (already in scope — the provider registry with `env` arrays), `envs` (already in scope — loaded env vars map)
- Produces: modified `// load apikeys` loop that skips stored keys when env var is already providing a key

- [ ] **Step 1: Locate the `// load apikeys` loop**

In `packages/opencode/src/provider/provider.ts`, find this block (around line 1501):

```typescript
        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          if (provider.type === "api") {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }
```

- [ ] **Step 2: Add the env-priority guard**

Replace only the inner `if (provider.type === "api")` block:

```typescript
        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          if (provider.type === "api") {
            const envKey = database[providerID]?.env.map((item) => envs[item]).find(Boolean)
            if (envKey) continue
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }
```

The two new lines are:
1. `const envKey = database[providerID]?.env.map((item) => envs[item]).find(Boolean)` — reuse the same env-var lookup already used in `// load env`
2. `if (envKey) continue` — skip stored key when env var is present

- [ ] **Step 3: Run type check**

```bash
cd packages/opencode && bun typecheck
```

Expected: no errors.

- [ ] **Step 4: Run the new test to verify it passes**

```bash
cd packages/opencode && bun test test/provider/provider.test.ts --test-name-pattern "env var takes precedence over stored API key"
```

Expected: **PASS**

- [ ] **Step 5: Run the full provider test suite to check for regressions**

```bash
cd packages/opencode && bun test test/provider/provider.test.ts
```

Expected: all existing tests **PASS**.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/provider/provider.ts packages/opencode/test/provider/provider.test.ts
git commit -m "fix(core): env var api key takes precedence over stored key"
```
