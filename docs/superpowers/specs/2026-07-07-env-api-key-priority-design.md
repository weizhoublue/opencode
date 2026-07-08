# Design: Env Var API Key Takes Precedence Over UI-Stored Key

**Date**: 2026-07-07  
**Scope**: `packages/opencode/src/provider/provider.ts`

## Problem

When a user configures an API key through the interactive UI (stored in the auth database), that stored key currently **overrides** any `OPENCODE_API_KEY` environment variable set at launch time. This makes it impossible to switch keys via the command line without modifying stored configuration.

The root cause: in the provider loading sequence, `// load env` runs before `// load apikeys`. Because `mergeDeep` is applied sequentially, the later call (`// load apikeys`) overwrites the `key` field set by the earlier `// load env` call.

## Goal

When a provider's environment variable (e.g. `OPENCODE_API_KEY`) is set at launch time, it must take precedence over any stored API key configured through the UI. This lets users switch keys by setting the env var without touching stored configuration.

## Design

**File**: `packages/opencode/src/provider/provider.ts`  
**Location**: `// load apikeys` loop (around line 1502)

In the `// load apikeys` loop, before merging a stored API key into the provider, check whether any of that provider's declared environment variables are already set. If so, skip the stored key — the env var wins.

```typescript
// load apikeys
const auths = yield* auth.all().pipe(Effect.orDie)
for (const [id, provider] of Object.entries(auths)) {
  const providerID = ProviderV2.ID.make(id)
  if (disabled.has(providerID)) continue
  if (provider.type === "api") {
    const envKey = database[providerID]?.env.map((item) => envs[item]).find(Boolean)
    if (envKey) continue   // env var takes precedence over stored key
    mergeProvider(providerID, {
      source: "api",
      key: provider.key,
    })
  }
}
```

The `database[providerID]?.env` array is the same list of env var names already used in the `// load env` section (e.g. `["OPENCODE_API_KEY"]` for the opencode provider). Re-using this lookup ensures the two sections stay in sync.

## Scope

This change applies to **all providers**, not just opencode. The policy — "an explicitly set runtime env var overrides persisted configuration" — is a sound general principle and reduces special-case branching.

## Non-Goals

- Does not affect the `opencode.ts` plugin's `hasKey` check (line 166), which independently determines whether to operate in public mode. That logic already checks `process.env.OPENCODE_API_KEY` first and remains correct.
- Does not change behavior when no env var is set — stored keys continue to work as before.
- Does not affect OAuth credentials; only `provider.type === "api"` (stored API keys) is touched.

## Merge Conflict Risk

Low. The change is a 2-line addition inside an existing loop. It does not move or restructure any code blocks, minimizing diff size and conflict surface when merging upstream changes.
