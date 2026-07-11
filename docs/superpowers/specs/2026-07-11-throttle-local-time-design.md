# Throttle Local Time Format Design

## Goal

Make `~/.config/opencode/throttle.json` directly readable during debugging by storing throttle window timestamps as local ISO 8601 strings.

## Scope

- Change only `packages/opencode` throttle persistence and its tests.
- Store `startTime` and `endTime` as strings with milliseconds and an explicit local UTC offset.
- Do not retain numeric timestamp compatibility or migrate existing throttle files.

## Data Format

Each throttle record keeps its existing key metadata and writes the two timestamps as local ISO 8601 values:

```json
{
  "source": "OPENCODE_API_KEY",
  "key_hint": "***gl2Y6wtp",
  "key_hash": "ab4f91f54d2e82fcd5bdef723ee9febff2826980f26d8d00d4a67999bf0dee09",
  "startTime": "2026-07-11T14:21:02.689+08:00",
  "endTime": "2026-07-11T16:21:02.689+08:00"
}
```

The offset is required: it makes a record self-contained when inspected or copied on another machine. The value represents the current host's local timezone when the record is written.

## Behavior

`ThrottleStore.addThrottle` obtains current time and expiry, converts both to local ISO 8601 strings, then persists them.

`ThrottleStore.isThrottled` and expired-record cleanup parse `endTime` before comparing it with current time. Only the string format is accepted. A legacy numeric timestamp is invalid input and follows the store's existing read-error behavior; it is not converted or preserved.

## Testing

- Assert persisted `startTime` and `endTime` are strings containing milliseconds and a UTC offset.
- Assert active and expired persisted string records respectively block and allow a key.
- Assert a written window has the configured duration after parsing both strings.
- Update CLI fixtures to use string timestamps.
