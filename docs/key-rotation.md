# API Key Rotation & Throttle Suppression

## 用户使用方式

### 配置多个 API Key

在 `OPENCODE_API_KEY` 中用英文逗号分隔多个 key：

```bash
export OPENCODE_API_KEY="sk-key1,sk-key2,sk-key3"
opencode run "帮我写一个排序函数"
```

opencode 会依次从 key1 开始尝试。遇到限额（429）或无效 key（401）时自动切换到下一个，对用户完全透明。

### 相关环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENCODE_API_KEY` | 无 | 逗号分隔的 API key 列表 |
| `OPENCODE_THROTTLE_ENABLE` | `true` | 设为 `false` 可禁用跨进程限流记录 |
| `OPENCODE_THROTTLE_DURATION` | `120`（分钟） | 限流记录的有效期 |
| `OPENCODE_WELAN_LOG` | `true` | 设为 `false` 可禁用 welan.txt 日志 |

### 跨进程限流（多个 opencode 进程共存时）

限流状态保存在 `~/.config/opencode/throttle.json`。当某个 key 触发 429 时，当前进程把该 key 写入此文件并附上失效时间。其他进程启动时读取该文件，自动跳过仍在限流期内的 key——无需任何手动操作。

```
~/.config/opencode/
├── throttle.json    # 跨进程限流状态（自动管理）
└── welan-log.txt   # key 轮转决策日志
```

### 日志（welan.txt）

key 轮转决策会写两份日志：

- `~/.config/opencode/welan-log.txt`：专用排查日志，保留进程前缀。
- `~/.local/state/opencode/log/opencode.log`（随 `Global.Path.log` 配置变化）：遵循 opencode 原有结构化日志格式。设置 `OPENCODE_PRINT_LOGS=1` 时，也按原有日志机制输出到 stderr。

`welan-log.txt` 示例：

```
[012300000Z] [2026-07-10T09:23:00.000] [INFO] key-rotation: start, 2 key(s) configured
[012300000Z] [2026-07-10T09:23:05.000] [ERROR] key-rotation: key ***key-1 throttled for 120 minutes, writing throttle record
[012300000Z] [2026-07-10T09:23:05.000] [ERROR] key-rotation: key ***key-1 quota_limit, trying next
[012300000Z] [2026-07-10T09:23:05.000] [INFO] key-rotation: attempt 2 with key ***key-2
[012300000Z] [2026-07-10T09:23:10.000] [INFO] key-rotation: success with key ***key-2
```

Key 在日志中脱敏，只显示最后 6 位。第二列（如 `[012300000Z]`）是进程级前缀，同一 CLI 进程的所有日志共享该值，方便在多进程并发时区分来源。

`opencode.log` 示例：

```
timestamp=2026-07-10T09:23:05.000Z level=ERROR run=abcd1234 message="key-rotation: key ***key-1 quota_limit, trying next"
```

### CLI 错误输出

单 key 命中已识别的 quota/rate-limit 时，CLI 在 stderr 输出：

```text
Error: OPENCODE_QUOTA_LIMIT: <provider 或 retry 消息>
```

多 key 轮转中，某个 key 命中 quota 而后续 key 成功时，CLI 不输出该中间错误。所有 key 最终耗尽时，CLI 只输出一次 `OPENCODE_QUOTA_LIMIT` 前缀；若最后一次请求有 provider 消息则保留该消息，否则输出 `all configured API keys are exhausted or throttled`。最后终态是无效 key 时，输出 `OPENCODE_INVALID_API_KEY: <message>`。

---

## 内部实现

### 模块结构

```
packages/opencode/src/
├── provider/
│   ├── throttle-store.ts   # 读写 throttle.json，Flock 写锁
│   ├── rotation-logger.ts  # 追加写 welan-log.txt，fire-and-forget
│   └── key-rotator.ts      # 解析 key 列表，管理轮转状态
├── session/
│   └── retry.ts            # isInvalidKeyAPIError（401 检测）
└── cli/cmd/
    └── run/key-rotation.ts # runWithKeyRotation 轮转主循环
```

这三个新模块没有任何 Effect / Provider / Session 依赖，可以单独使用。

### 轮转流程

```
opencode run "prompt"
       │
       ▼
runWithKeyRotation({ createSdk, execute, reset, onExhausted })
  │
  ├─ KeyRotator.selectKey()
  │     ├─ 读 throttle.json（无锁）
  │     ├─ 跳过限流期内的 key
  │     └─ 跳过本进程已标记无效的 key
  │
  ├─ process.env.OPENCODE_API_KEY = selectedKey
  ├─ disposeInstance(directory)      ← 仅在第 2 次以后调用
  ├─ Server.Default.reset()          ← 仅在第 2 次以后调用
  │    └─ 清除目录级 InstanceState 与惰性 Server，下次 fetch 读新 key
  │
  ├─ execute(sdk)
  │     └─ 遇到可轮换错误时抛出 KeyRotationRetry
  │
  ├─ quota_limit  → KeyRotator.recordThrottle(key) → 写 throttle.json → 换 key
  ├─ invalid_key  → KeyRotator.markInvalid(key) → 进程内跳过 → 换 key
  └─ success      → 结束
```

### 关键设计决策

**disposeInstance() + Server.Default.reset()** — Provider key 缓存在目录级 `InstanceState` 中。换 key 前先清除当前目录的 InstanceState，再 reset 惰性 Server，下一次 HTTP 请求会用新的 `process.env.OPENCODE_API_KEY` 重建本地执行路径。这样不需要在 Provider/Env 层监听全局 env 变化。

**KeyRotationRetry** — `execute()` 保留原来的成功/失败返回语义。只有 429/quota/rate-limit 和 401 这两类可轮换错误会抛出 `KeyRotationRetry`，由外层 `runWithKeyRotation()` 捕获并换 key。

**Session 复用** — 显式传入 session ID 时，每次 `execute()` 都按原始 CLI 参数解析并复用同一 session。未传入 session ID 时，每次轮转沿用原有 CLI 语义创建新 session；失败 key 创建但未成功执行的 session 不会被下一次尝试继承。

**锁策略** — `isThrottled`（读）不加锁，宁可偶发读到旧数据也不阻塞 API 调用。`addThrottle` / `cleanExpired`（写）使用 `Flock.acquire`，超时 2s 后放弃写入（宁漏记，不阻塞）。进程崩溃导致的僵尸锁通过 `staleMs: 10_000` 自动清理。

**throttleEnabled 默认开启** — `OPENCODE_THROTTLE_ENABLE !== "false"`，未设置时视为开启。`retry.ts` 中的同名判断也用同一逻辑，确保 429 能直接冒泡到外层轮转循环，而不是在 SDK 内部重试同一个已限流的 key。
