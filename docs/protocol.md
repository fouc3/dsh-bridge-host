# dsh-bridge 通信协议

客户端与 `dsh-bridge` 之间是**换行分隔的 JSON**（NDJSON），一条 TCP 连接内：

1. 客户端发送**握手帧**（必须是第一行）；
2. 服务端回一条握手结果；
3. 之后客户端可发送任意多条请求，服务端逐条回响应。

握手必须在 `DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS`（默认 5s）内完成，否则连接被关闭。

---

## 1. 握手

```json
{"token": "<与 DSH_BRIDGE_TOKEN 一致>"}
```

成功：

```json
{"ok": true}
```

失败（随后连接被服务端关闭）：

```json
{"ok": false, "error": {"code": "unauthorized"}}
```

> 令牌比较使用 `timingSafeEqual`（先比长度再逐字节恒定时间比较）。
> 失败原因**不对外暴露**（只说 `unauthorized`），只在服务端日志中记录具体原因，避免泄漏探测信息。

---

## 2. 请求

```json
{"id": "<任意字符串>", "op": "<操作名>", "args": { ... }}
```

* `id` 会被原样回显，用于并发请求的关联；缺省为 `null`。
* `op` 必须是下表之一，否则回 `unknown-op`（连接保持）。
* `args` 缺省视为 `{}`。

## 3. 响应

成功：

```json
{"id": "<同请求>", "ok": true, "value": { ... }}
```

失败：

```json
{"id": "<同请求>", "ok": false, "error": {"code": "<稳定错误码>", "message": "<人类可读>"}}
```

---

## 4. 操作集

| `op` | `args` | 返回 `value` |
|---|---|---|
| `ping` | 无 | `{ok: true, agentCommand}` |
| `sessions_list` | `cwd?`, `filterCwd?`, `source?`（`agent` 默认 / `local`） | `{source, sessions: [{sessionId, name, cwd, closed, lastUsedAt}]}` |
| `sessions_new` | `cwd?`, `name?` | `{sessionId, cwd, name}` |
| `prompt` | `text`(必填), `cwd?`, `name?` | `{reply, stopReason, sessionId, toolCalls, usage, status}` |
| `sessions_history` | `cwd?`, `name?`, `limit?` | `{history: ["<行>", ...]}` |
| `cancel` | `cwd?`, `name?` | `{ok: true}` |
| **`dispatch`** | `text`(必填), `streamId`(必填), `cwd?`, `name?`, `meta?` | `{taskId, status: "running", dispatched: true, sessionName}` |
| **`task_status`** | `taskId`(必填) | `{taskId, streamId, status, reply, stopReason, cwd, sessionName, sessionId, startedAt, finishedAt}` |
| **`task_list`** | `limit?` | `{tasks: [{taskId, streamId, status, cwd, startedAt, finishedAt, notified}]}` |
| **`task_replay`** | 无 | `{attempted, delivered}` |
| **`sessions_ensure`** | `cwd?`, `name?` | `{sessionId, created, cwd, name}` |
| **`workspaces`** | `cwd?`, `source?`(`agent`/`local`), `namedOnly?`, `maxPerWorkspace?` | `{workspaces: [{cwd, sessionCount, namedCount, lastUsedAt, sessions: [...]}], totalSessions, namedSessions, source}` |

### 会话名与工作区

**acpx 的会话身份是 `(agentCommand, cwd, name)` 三元组**，所以：

* **同一个 `cwd` + 同一个 `name`** → 接续同一段对话（助手记得之前聊的）；
* **换 `cwd` 或换 `name`** → 换了一段全新对话（实测：`beta` 不知道 `alpha` 记的暗号）。

`name` 可以随意起，如 `"文件整理"`、`"每周报告"`。没有名字时用该目录的默认会话。

`dispatch` 会在执行前先 `sessions ensure`：**会话不存在就自动创建**，
所以「接续会话 X」在第一万次和第一次一样好用，不会因为"还没建过"而失败。

> ⚠️ `-s/--session <name>` 是 **`prompt` 子命令**的选项，不能放在全局位置
> （放错位置 acpx 会直接报 `unknown option`）。桥已按正确位置构造。

### 工作区视图（`workspaces`）

按**工作目录**分组展示已知会话，回答「都有哪些工作区」和「某个工作区里有哪些会话」。

**数据来自两个来源的合并**，因为单独任何一个都不够：

| 来源 | 提供 | 局限 |
|---|---|---|
| ACP 列表 | 该 agent 知道的**全部**会话与目录 | **不返回会话名，也不返回时间** |
| acpx 本地记录 | **会话名**、最后使用时间 | 只覆盖 acpx 亲自调用过的目录 |

合并后：以 ACP 的身份与目录为准，本地记录补上 `name` 与 `lastUsedAt`。
两条来源都失败时才回退到本地记录。

**返回字段**：

| 字段 | 说明 |
|---|---|
| `cwd` | 工作目录 |
| `sessionCount` | 该目录下的会话总数 |
| `namedCount` | 其中有名字（= 可被明确继续）的数量 |
| `lastUsedAt` | 该目录最近活动时间，**可能为 `null`** |
| `sessions[]` | 该目录的会话，每条含 `sessionId` / `name` / `closed` / `lastUsedAt` |

**已知限制（实测）**：时间戳只有 acpx 本地记录过的那部分会话才有。
在真实部署里，绝大多数会话（尤其是历史项目目录下的）显示 `lastUsedAt: null`。
排序规则因此是：**有时间的按时间降序在前，无时间的按目录名稳定排在后面** ——
不会出现每次调用顺序乱跳的情况。

**参数**：

* `cwd`：只返回该目录（精确匹配）
* `namedOnly: true`：只列出带名字的会话 —— 想知道「能接着聊哪些」时用这个
* `maxPerWorkspace`：每个工作区最多列几条会话（默认 20），
  防止一个 `/tmp` 这种 65 个会话的目录把其他工作区全挤掉
* `source: "local"`：只用本地记录，不查 agent（更快，但覆盖面小）

### 说明

* `sessions_list` 默认走 ACP（`source: "agent"`），返回**真实会话**；
  `source: "local"` 只返回 acpx 自己记录过的会话。
* `prompt` 的 `reply` 由 ACP `agent_message_chunk` 流拼接而成；
  `stopReason` 是结束原因（`end_turn` 等）；`toolCalls` 是工具调用次数（不含内容）。
* `sessions_history` 返回的是 acpx 的文本输出按行切分，**不是结构化数据**。

### 异步派活（`dispatch`）

`dispatch` **立即返回**，绝不等 agent。后台执行完成后，桥会把结果 POST 到
`DSH_BRIDGE_CALLBACK_URL`（见下）。

* **`streamId` 必填**：它是"结果该回哪个聊天流"的唯一依据。桥不解析聊天内容，
  只原样保存并回传。
* **不受请求生命周期影响**：调用方在收到 `taskId` 后马上断开是**正常用法**，
  后台任务不会因此被取消。（这是与 `prompt` 的关键区别：`prompt` 会在客户端断开时中止。）
* **状态取值**：
  | status | 含义 |
  |---|---|
  | `running` | 还在跑 |
  | `done` | agent 停了下来，并且留下了文字 |
  | `error` | **没有可用的文字**：抛异常、输出为空、或 stopReason 异常 |
* **只有两种终态，没有"提问中"这种状态**。agent 停下来问问题时，它的回合同样正常结束了，
  桥这一层看到的和"干完了"一模一样 —— 所以它不去猜。
  到底该汇报进度还是把问题转达给用户，由**聊天侧读完整文字后自己判断**，
  因为它能看到对话上下文，而桥看不到。
* **`reply` 是完整原文**，不是摘要。就是为了让追问不必重跑。

### 回调投递

```
POST <DSH_BRIDGE_CALLBACK_URL>
Authorization: Bearer <DSH_BRIDGE_TOKEN>
Content-Type: application/json

{"taskId","streamId","status","reply","stopReason","cwd","startedAt","finishedAt"}
```

* 退避重试（1s / 4s / 16s），默认 3 次。
* **默认不发送原始 prompt**（避免把用户内容重复外发）；需要时用
  `buildCallbackPayload(task, {includePrompt: true})`。
* 投递最终失败**不丢任务**：账本里保持 `notified: false`，`task_list` 可见，
  桥重启时会自动重放（也可手动 `task_replay`）。

### 账本

任务记在 `${DSH_BRIDGE_STATE:-~/.dsh-bridge}/tasks.json`：

* 原子写（临时文件 + rename），并发写串行化。
* 保留策略：`DSH_BRIDGE_TASK_TTL_H`（默认 72 小时）与 `DSH_BRIDGE_TASK_MAX`（默认 200）。
* **淘汰时永不删除 `running` 的任务**。
* 这是可安全删除的数据文件。

## 5. 错误码

| code | 含义 | 客户端建议动作 |
|---|---|---|
| `unauthorized` | 握手令牌不匹配 | 检查配置，不要重试 |
| `bad-json` | 请求行不是合法 JSON | 修客户端 |
| `bad-request` | 请求不是对象 / 参数非法 | 修客户端 |
| `unknown-op` | 未知 `op` | 修客户端 |
| `busy` | 超出并发上限 | 稍后重试 |
| `no-session` | acpx 在作用域内找不到会话（退出码 4） | 先 `sessions_new` |
| `timeout` | 超过 `requestTimeoutMs` | 重试或缩小任务 |
| `output-too-large` | 子进程输出超过上限 | 缩小任务 |
| `cancelled` | 客户端断开，请求被中止 | 无需处理 |
| `agent-spawn-failed` | 无法启动 acpx | 检查安装 |
| `agent-failed` | acpx 非零退出 | 看 message 里的 stderr 摘要 |
| `internal` | 未预期错误 | 看服务端日志 |

## 6. 连接生命周期

* **客户端断开** → 该连接上所有在途请求被 `AbortController` 中止，子进程收到 `SIGTERM`（2s 后升级 `SIGKILL`）。
* **单行超过 1 MiB** → 连接被销毁。
* **并发**：服务端最多同时处理 `DSH_BRIDGE_MAX_CONCURRENCY` 个请求；**超出直接拒绝**（`busy`）而不是排队，保证过载立刻可见而非静默积压。
