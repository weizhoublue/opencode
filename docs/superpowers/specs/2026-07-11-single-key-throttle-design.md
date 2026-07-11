# 单 key quota throttle 记录

## 目标

`opencode run` 识别到 quota 后，始终将当前 API key 写入共享的
`throttle.json`。该记录供后续独立 CLI 进程查询，与本次调用是否存在
可轮转的备用 key 无关。

## 设计

保持 `KeyRotator` 为 throttle 的唯一读写边界。quota 引发的
`KeyRotationRetry` 在轮转控制器中先调用 `recordThrottle(currentKey)`，
随后再选择下一个未节流 key；没有下一个 key 时，保留原有 quota 错误并退出。

`OPENCODE_THROTTLE_ENABLE=false` 时维持既有语义，不读取或写入文件。

## 验证

- 单 key quota：非零退出，并写入当前 key 的哈希记录。
- 新 CLI 进程：读取该记录并在发起模型请求前退出。
- 多 key fallback、禁用 throttle 的现有回归测试继续通过。
