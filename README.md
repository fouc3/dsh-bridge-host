# dsh-bridge-host

把本地 **DeepSeek Harness** 通过一个带令牌鉴权的 TCP 端点暴露给容器内的调用方。

这是 [dsh-bridge-maibot](../dsh-bridge-maibot) 的**宿主侧**一半：在宿主机上常驻一个中转进程，
用 [acpx](https://github.com/openclaw/acpx) 驱动 `dsh --profile acp`，
让跑在 Docker 容器里的机器人能够派活、续聊、查会话。

---

## 为什么需要它

DeepSeek Harness 的 Web 服务与 ACP 都在本机回环或进程内 stdio 上，而调用方在容器里，够不到 `127.0.0.1`。

关键点：**宿主机本身就是 docker 网桥的网关**（通常是 `172.24.0.1`），
所以中转进程只要把端口 bind 在网桥 IP 上，容器就能直达 ——
不需要 `docker network connect`、不需要容器别名、不需要 sudo、不需要重建容器。

```
容器 (172.24.0.2)
   │  TCP <网桥IP>:13081  +  Bearer <token>
   ▼
本进程（宿主机，普通用户）
   ├─ 监听 + 令牌握手
   ├─ 任务账本（可选，供异步派活）
   └─ spawn acpx --agent 'dsh --profile acp'  ──▶  dsh --profile acp (stdio)
```

---

## 快速开始

```bash
cd bridge
npm install

# 令牌：只从环境变量读，不落盘、不进版本库
export DSH_BRIDGE_TOKEN=$(openssl rand -hex 32)
export DSH_BRIDGE_HOST=172.24.0.1        # 换成你的 docker 网桥网关
./dsh-bridge
```

看到这三行即成功：

```
dsh-bridge: listening on 172.24.0.1:13081
dsh-bridge: agent command: dsh --profile acp
dsh-bridge: concurrency 4, request timeout 600000ms
```

自测（另开终端）：

```bash
node --test test/*.test.mjs            # 71 项，无需 agent
python3 test/plugin_protocol_test.py   # 协议一致性，起真 bridge
```

真实端到端（**消耗模型额度**）：

```bash
DSH_E2E=1 node --test test/e2e-dispatch.test.mjs
DSH_E2E=1 node --test test/e2e-sessions.test.mjs
```

完整部署步骤见 **[docs/deployment.md](docs/deployment.md)**。

---

## 能力

协议细节见 **[docs/protocol.md](docs/protocol.md)**。概览：

| op | 作用 |
|---|---|
| `ping` | 健康检查 |
| `sessions_list` / `sessions_new` / `sessions_ensure` | 列出 / 新建 / 幂等获取会话 |
| `workspaces` | **按工作目录分组**列出所有会话 |
| `prompt` | 同步提问（阻塞到 agent 停下） |
| `dispatch` | **异步派活**：立即返回 `taskId`，干完回调 |
| `task_status` / `task_list` / `task_replay` | 查任务、列任务、重放未送达的回调 |
| `sessions_history` / `cancel` | 历史、取消 |

### 异步派活

`dispatch` **不等 agent**，登记任务后立即返回；后台跑完再把结果 POST 到
`DSH_BRIDGE_CALLBACK_URL`。调用方收到 `taskId` 后马上断开是**正常用法**，
任务不会被取消（这与 `prompt` 相反）。

投递失败会退避重试；最终失败**不丢任务** —— 账本里保持 `notified: false`，
桥重启时自动重放。

### 会话与工作区

**acpx 的会话身份是 `(agentCommand, cwd, name)` 三元组**：

* 同 `cwd` + 同 `name` → 接续同一段对话；
* 换 `name` 或换 `cwd` → 换一段全新对话。

`workspaces` 的数据来自**两个来源的合并**：ACP 列表提供完整的目录版图（但不含名字与时间），
acpx 本地记录补上会话名与最后使用时间（但只覆盖 acpx 跑过的目录）。

> **已知限制**：时间戳只有 acpx 本地记录过的会话才有，多数历史会话的
> `lastUsedAt` 为 `null`。排序规则是「有时间的降序在前，无时间的按目录名稳定排在后面」。

### 任务状态

只有两种终态，**没有「提问中」这种状态**：

| status | 含义 |
|---|---|
| `done` | agent 停了下来并留下文字 |
| `error` | **没有可用文字**：抛异常、输出为空、stopReason 异常 |

agent 停下来问问题时，回合同样正常结束 —— 桥这一层看到的和「干完了」没有区别，
所以它**不去猜测**。到底该汇报还是该追问，交给能看到完整对话的调用方判断。

---

## 配置

全部通过环境变量，见 `bridge/src/config.mjs`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_TOKEN` | 无（**必填**） | 共享令牌，≥16 字符，缺失即拒绝启动 |
| `DSH_BRIDGE_HOST` | `172.24.0.1` | 监听地址 |
| `DSH_BRIDGE_PORT` | `13081` | 监听端口；`0` = 随机（测试用） |
| `DSH_BRIDGE_AGENT` | `dsh --profile acp` | acpx 驱动的 agent 命令 |
| `DSH_BRIDGE_CALLBACK_URL` | 空 | 异步结果回调地址；空 = 不回调 |
| `DSH_BRIDGE_MAX_CONCURRENCY` | `4` | 并发上限 |
| `DSH_BRIDGE_TIMEOUT_MS` | `600000` | 单请求超时 |
| `DSH_BRIDGE_LEDGER` | `~/.dsh-bridge/tasks.json` | 任务账本，**可安全删除** |
| `DSH_BRIDGE_TASK_TTL_H` | `72` | 完成任务保留小时数 |
| `DSH_BRIDGE_TASK_MAX` | `200` | 保留任务上限 |

> ⚠️ `DSH_BRIDGE_AGENT` 是 acpx 的 **session scope key**。升级时保持该字符串不变，
> 否则已有会话不再被解析到。

---

## 常驻运行

仓库里的 `bridge/dsh-bridge.service` 是 **systemd user unit 模板**，未安装：

```bash
install -m 600 /dev/null ~/.config/dsh-bridge.env
printf 'DSH_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.config/dsh-bridge.env
mkdir -p ~/.config/systemd/user
cp bridge/dsh-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-bridge.service
```

该 unit **不依赖、不触碰任何 dsh 服务** —— `dsh-web.service` 重启不影响它。

---

## 安全

agent **能在宿主机执行任意命令**，所以这个端口等于一个高权限入口：

* 令牌是唯一门禁，比较用 `timingSafeEqual`；
* 令牌只从**环境变量**读取，不落盘、不进版本库；
* 日志只记 op、耗时、退出码，**不记录 prompt 正文**；
* 建议只 bind 网桥 IP，不要 `0.0.0.0`。

---

## 测试

| 套件 | 覆盖 |
|---|---|
| `auth` | 令牌校验、前缀攻击、超长/畸形握手 |
| `fold` | ACP 帧折叠、会话行解析 |
| `server` | 握手门禁、帧协议、并发上限、断连中止在途请求 |
| `ledger` | 账本原子写、TTL/上限淘汰、状态判定 |
| `dispatch` | **非阻塞**（派活 <500ms）、结果留存、回调退避重试、超时 |
| `sessions` | 具名会话 argv 位置、合并与分组、排序确定性 |
| `plugin_protocol_test.py` | 线上协议一致性（含真实会话列表） |
| `e2e-dispatch` | **真实异步闭环**：派活立即返回 → 后台执行 → 回调送达 |
| `e2e-sessions` | **真实会话隔离**：同名记得暗号、异名不串味 |

---

## 相关仓库

* **[dsh-bridge-maibot](../dsh-bridge-maibot)** —— 麦麦（MaiBot）侧的插件，本仓库的调用方。

## 许可

MIT
