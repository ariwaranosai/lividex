# Livis Codex Gateway

一个本地轻量网关，直接连接理想 Livis 中继服务与本机 `codex app-server`，不依赖 OpenClaw。

```text
理想同学 App / 眼镜
        ↕ Livis WebSocket relay
livis-codex gateway
        ↕ JSONL app-server protocol
本机 Codex
```

## 前提

- macOS 或 Linux
- Node.js 22+
- `codex` 命令可用，并已在本机登录
- 能访问理想 IDaaS 和 Livis Gateway

默认模型为 `gpt-5.6-sol`。本机需安装支持 GPT-5.6 的 Codex CLI；如需覆盖，
可在 `~/.livis-codex/config.json` 中修改 `codex.binary` 或 `codex.model`。

## 使用

```bash
cd /path/to/livis_codex

# 初始化配置；默认 Codex 工作目录就是当前项目
npm run setup -- --cwd /path/to/codex/workspace

# 登录理想账号，完成 Device Flow 授权
npm run login

# 将显示的 Agent ID 填入理想同学 App 的「连接我的 Agent」

# 启动网关
npm start
```

网关启动时会同时启动本地只读控制台：

```text
http://127.0.0.1:8765
```

控制台每秒刷新 Livis 连接状态、当前模型与推理等级。每个活跃线程会展示任务输入、已运行时长、当前阶段、Codex 提供的推理摘要、Skill 和工具调用轨迹；不展示模型内部隐藏思维链。后台任务以“状态、任务 ID、输入问题、节点、更新时间、结果”表格分页展示，每页 10 条、最多 50 条，不长期保存执行轨迹。
任务列表与本地已完成历史只保留最新 50 条；运行中和等待 Livis 回执的任务不会被清理。
默认只监听 loopback，不暴露到局域网。

检查环境：

```bash
npm run doctor
```

退出并吊销 Livis refresh token：

```bash
node src/cli.js logout
```

## 本地状态

默认保存在 `~/.livis-codex/`：

- `config.json`：Livis 与 Codex 配置
- `tokens.json`：Livis refresh token，权限 `0600`
- `agent.id` / `device.id`：绑定标识
- `state.json`：每个 Livis node 对应的 Codex thread，以及任务去重状态

可通过 `LIVIS_CODEX_HOME` 指向其他状态目录。

## 在 NAS 上用 Docker Compose 运行

镜像基于 Node.js 22，并安装与本项目验证过的 `codex-cli 0.145.0`。同时支持
`linux/amd64` 与 `linux/arm64`，具体取决于 NAS 上 Docker 所选基础镜像架构。

首次部署：

```bash
cp .env.example .env
mkdir -p workspace

# 编辑 .env，把 CODEX_WORKSPACE 指向允许 Codex 操作的 NAS 目录。
# 如果要从局域网打开控制台，把 DASHBOARD_BIND_IP 改为 NAS 的局域网 IP。

docker compose build

# 生成 Livis-Codex 配置，保存在 livis-state volume。
docker compose run --rm livis-codex \
  node src/cli.js setup --cwd /workspace

# 登录 Codex，浏览器打开终端给出的 device-auth 地址。
docker compose run --rm livis-codex \
  codex login --device-auth

# 登录 Livis；复制终端给出的地址到浏览器完成授权。
docker compose run --rm livis-codex \
  node src/cli.js login --no-browser

# 将输出的 Agent ID 绑定到理想同学 App 后启动。
docker compose up -d
docker compose logs -f livis-codex
```

控制台地址为 `http://<DASHBOARD_BIND_IP>:<DASHBOARD_PORT>`。页面没有身份验证，
并会展示任务输入和结果，因此默认只发布到 `127.0.0.1`；不要通过路由器端口转发或反向代理直接暴露到公网。

常用维护命令：

```bash
# 查看 Agent ID 与健康状态
docker compose run --rm livis-codex node src/cli.js agent-id
docker compose ps

# 更新代码后重建并滚动重启
docker compose build --pull
docker compose up -d

# 停止服务，但保留两个登录态 volume
docker compose down

# 警告：加 -v 会删除 Livis 和 Codex 登录态，需要重新登录
docker compose down -v
```

`CODEX_WORKSPACE` 是 Codex 在容器内唯一挂载的业务目录。建议专门创建一个目录，
不要挂载 NAS 根目录、用户家目录、Docker socket 或包含私钥/相册/备份的共享目录。
容器默认以非 root 的 `uid=1000(node)` 运行；NAS 上挂载的工作目录需要允许 UID 1000
读写。可先运行 `docker compose run --rm livis-codex id` 确认容器身份，再通过 NAS ACL
只给这个目录所需权限。

## 安全模型

- Livis 输入被视为不可信远端输入。
- 默认 Codex sandbox 为 `workspace-write`，仅以配置中的 `codex.cwd` 为工作目录。
- 默认使用 `approvalPolicy: on-request` 与 `approvalsReviewer: auto_review`：越过 sandbox
  边界的请求由 Codex 独立 reviewer 自动审核，而不是等待人工确认。
- Auto-review 只替换审批人，不扩大 writable roots、网络或文件权限；若审批请求意外透传到
  网关客户端，网关仍会 fail closed 并拒绝它。
- 每个 `from_node_id` 使用独立 Codex thread，避免不同设备共享上下文。
- 如不需要修改文件，可将 `config.json` 中 `codex.sandbox` 改为 `read-only`。
- 不建议配置 `danger-full-access`，远端账号或 Livis relay 被攻破时会直接放大为本机权限。

## 已实现的 Livis 协议

- IDaaS Device Flow：`/aux`、`/token`、refresh、revoke
- WebSocket `connect`、`heartbeat`、`token_refresh`
- `send_message` / `ack_send_message`
- `send_result` / `ack_send_result`
- `cancel_chat` / `ack_cancel_chat`
- 断线指数退避重连
- job 去重和结果重发
- 对 Livis 发起的长任务，保留原始 `job_id` 并在完成后异步发送结果

当前 Livis v2.0.0 协议没有无关联的主动通知类型。本地产生且没有 Livis `job_id` 的任务
只能在控制台查看，不能可靠地伪装成一条 Livis 主动消息。

当前版本只返回文本，不实现 Livis 文件上传。文件能力应在明确限定允许目录后再添加，避免远端 prompt 任意读取本地文件。

## 开发验证

```bash
npm test
npm run check

# 可选：真实启动本机 app-server，创建并自动删除一个测试线程
npm run smoke:codex
```

Codex app-server 协议随 Codex 版本演进。当前实现已针对本机 `codex-cli 0.145.0`
和 `gpt-5.6-sol` 实测以下链路：

```text
initialize → thread/start|resume → turn/start
→ item/agentMessage/delta → turn/completed
```
