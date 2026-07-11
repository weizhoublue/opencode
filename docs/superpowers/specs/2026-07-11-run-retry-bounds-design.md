# Run Retry Bounds Design

## Goal

Ensure non-interactive `opencode run` never waits indefinitely for retryable provider failures while preserving immediate quota handling and API-key rotation.

## Scope

- Apply retry bounds only to `opencode run`.
- Keep TUI, Server, SDK, and the global `SessionRetry.policy` unchanged.
- Keep known quota and invalid-key rotation behavior unchanged.
- Do not add user configuration or Protocol fields.

## Error Classification

Known quota and rate-limit errors remain terminal for a key:

- Structured Zen/Go types: `RateLimitError`, `FreeUsageLimitError`, `GoUsageLimitError`, and `BlackUsageLimitError`.
- Structured codes: existing quota and rate-limit codes already recognized by `SessionRetry`.
- The reproduced OpenCode Go message: `usage limit reached` together with `enable usage from your available balance`.

New provider-specific quota codes or messages are added only with a redacted production sample and a regression test. Do not match broad words such as `month`, `balance`, or `billing` alone.

## Run Retry Policy

When `opencode run` receives `session.status.retry`:

1. A recognized quota or rate-limit aborts the Session immediately. A single key exits nonzero. Multiple keys rotate only for quota or invalid-key errors.
2. A non-quota retry may schedule at most five retries after the initial request.
3. The retry window starts at the first non-quota retry and ends after 120 seconds.
4. If the next scheduled retry would exceed that window, abort immediately instead of waiting.
5. On either retry bound, abort the Session and exit nonzero with `OPENCODE_RETRY_LIMIT: <message>`.
6. Retry-limit errors never rotate keys and never write `throttle.json`.

The `session.status.retry.attempt` value controls the count. Attempts 1 through 5 are allowed; attempt 6 is rejected before it waits.

## Output Contract

- Text quota errors start with `OPENCODE_QUOTA_LIMIT:`.
- Text retry-bound errors start with `OPENCODE_RETRY_LIMIT:`.
- JSON error events retain the original error fields and set the top-level `error.message` to the corresponding prefixed message.
- For quota JSON events, fields including `type`, `attempt`, `action`, and `next` remain present.

## Testing

- Unit tests cover structured quota classifications, reproduced Go text, and retryable classifications.
- Process tests cover single-key quota exits, JSON quota markers, five retryable failures followed by success, and a sixth failure that exits with `OPENCODE_RETRY_LIMIT`.
- A `Retry-After` beyond 120 seconds exits immediately without sleeping.
- Key-rotation process tests cover first-key exhaustion followed by success, all-key exhaustion, and `OPENCODE_THROTTLE_ENABLE=false`.
- Release verification rebuilds a temporary binary and runs `/usr/sbin/opencode-cheap run 'hi'` and `/usr/sbin/opencode-cheap run --format json 'hi'`; both must exit nonzero without timeout and expose the quota marker.
