# 部署指南

## 前置条件

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node.js | ≥ 22.13（acpx 要求） | v26.10.0 ✅ |
| `dsh` | 已安装，`dsh --profile acp` 可用 | 0.1.7-rc.2 ✅ |
| 麦麦 | 容器化部署，插件目录可写 | `maim-bot-core` ✅ |

## 网络拓扑

```
麦麦容器 maim-bot-core (172.24.0.2)
      │  TCP 172.24.0.1:13081  +  token 握手
      ▼
宿主 dsh-bridge  ←→  acpx  ←→  dsh --profile acp (stdio)
```

宿主本身就是该 bridge 网络的网关（`172.24.0.1`），因此中转进程**只需把端口 bind 在网桥 IP 上**，
不需要 `docker network connect`、不需要容器别名、不需要 sudo。

> 用 `docker network inspect maibot-docker_maim_bot --format '{{.IPAM.Config}}'` 确认网桥网关地址。
> 若你的麦麦用了别的网络名/网段，改 `DSH_BRIDGE_HOST` 即可。

---

## 步骤 1：生成共享令牌

```bash
install -m 600 /dev/null ~/.config/dsh-bridge.env
printf 'DSH_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.config/dsh-bridge.env
```

> ⚠️ 该文件**不要**放进版本库。令牌等同于一台上能跑任意命令的 agent 的钥匙。

## 步骤 2：安装依赖并试运行

```bash
cd ~/Projects/dsh-bridge-host/bridge
npm install
set -a; . ~/.config/dsh-bridge.env; set +a
DSH_BRIDGE_HOST=172.24.0.1 ./dsh-bridge          # 前台跑，Ctrl-C 退出
```

看到这三行即成功：

```
dsh-bridge: listening on 172.24.0.1:13081
dsh-bridge: agent command: dsh --profile acp
dsh-bridge: concurrency 4, request timeout 600000ms
```

## 步骤 3：自测（宿主侧）

另开一个终端：

```bash
cd ~/Projects/dsh-bridge-host
python3 test/plugin_protocol_test.py     # 协议一致性
DSH_E2E=1 node --test test/e2e.test.mjs  # 真实建会话+发消息（会消耗模型额度）
```

## 步骤 4：容器侧连通性验证

```bash
docker exec maim-bot-core python3 - <<'PY'
import json, socket, os
s = socket.create_connection(("172.24.0.1", 13081), timeout=10)
f = s.makefile("rwb")
f.write((json.dumps({"token": os.environ["TOKEN"]}) + "\n").encode()); f.flush()
print("handshake:", f.readline().decode().strip())
f.write((json.dumps({"id": "1", "op": "ping", "args": {}}) + "\n").encode()); f.flush()
print("ping:", f.readline().decode().strip())
PY
```

> 把 `TOKEN` 通过 `docker exec -e TOKEN=...` 传入，不要写进命令历史里的明文文件。

## 步骤 5：常驻运行

仓库里的 `bridge/dsh-bridge.service` 是 **user unit 模板**，尚未安装。启用方式由你决定：

```bash
mkdir -p ~/.config/systemd/user
cp ~/Projects/dsh-bridge-host/bridge/dsh-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-bridge.service
```

> 该 unit **不依赖也不触碰任何 dsh 服务**。`dsh-web.service` 重启不影响它。

## 步骤 6：部署麦麦插件

插件源码在**另一个仓库** [`dsh-bridge-maibot`](https://github.com/fouc3/dsh-bridge-maibot) 的 `plugin/` 下。
麦麦插件的属主是容器内的 `root`，所以拷贝需要 sudo：

```bash
sudo cp -r ~/Projects/dsh-bridge-maibot/plugin \
           /tmp/maibot-docker/data/MaiMBot/plugins/deepseek-v4-pro_dsh-harness
```

然后在麦麦 WebUI → 插件管理中：

1. 确认插件被发现；
2. 填写 `bridge_token`（与宿主一致）；
3. **填写 `allowed_senders`**（否则插件不响应任何人）；
4. 按需调整 `default_cwd`、`enable_write_ops`。

最后让宿主的回调能到达插件 —— 设置 `DSH_BRIDGE_CALLBACK_URL`，
指向容器在该网桥上的地址：

```bash
DSH_BRIDGE_CALLBACK_URL=http://172.24.0.2:13082/event
```

> 用 `docker inspect <容器> --format '{{.NetworkSettings.Networks}}'` 查它的真实 IP。
> 不设这一项时异步派活仍可用，只是干完不会主动汇报（结果仍留在账本里可查）。

---

## 配置项（宿主侧）

全部通过环境变量；见 `bridge/src/config.mjs`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_TOKEN` | 无（必填） | 共享令牌，≥16 字符，缺失即拒绝启动 |
| `DSH_BRIDGE_HOST` | `172.24.0.1` | 监听地址 |
| `DSH_BRIDGE_PORT` | `13081` | 监听端口；`0` = 随机（测试用） |
| `DSH_BRIDGE_AGENT` | `dsh --profile acp` | acpx 驱动的 agent 命令 |
| `DSH_BRIDGE_MAX_CONCURRENCY` | `4` | 并发上限 |
| `DSH_BRIDGE_TIMEOUT_MS` | `600000` | 单请求超时 |
| `DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS` | `5000` | 握手超时 |
| `DSH_BRIDGE_MAX_OUTPUT_BYTES` | `8388608` | 子进程输出上限 |
| `DSH_BRIDGE_ACPX` | `bridge/node_modules/.bin/acpx` | acpx 路径 |

> ⚠️ `DSH_BRIDGE_AGENT` 是 **acpx 的 session scope key**。升级时保持该字符串不变，
> 否则已有会话不再被解析到（scope 变了 = 换了另一个会话库）。

---

## 排障

### 容器连不上 `172.24.0.1:13081`

1. 宿主上确认在监听：`ss -tlnp | grep 13081`
2. 找对网关地址：`docker network inspect maibot-docker_maim_bot --format '{{.IPAM.Config}}'`
3. **不要用 `host.docker.internal`** —— 在有 Clash/TUN 的机器上它可能被解析成
   `198.18.x.x` 这类 fake-ip，看起来能通，实际是代理旁路，不稳定。

### `agent-failed` 且提到 `no session in scope`

acpx 的 `prompt` 只续聊已存在的会话；先调 `sessions_new`。

### 会话莫名"换了"

`DSH_BRIDGE_AGENT` 或 `cwd` 变了。acpx 的会话身份是 `(agentCommand, cwd, name)` 三元组。

### `busy`

并发打满。调大 `DSH_BRIDGE_MAX_CONCURRENCY`，或让调用方串行。
