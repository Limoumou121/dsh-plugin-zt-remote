# dsh-plugin-zt-remote

一个只绑 ZeroTier 网卡的 DeepSeek Harness 远程接口。它在运行 Harness Host 的机器上，
把**一个** HTTP 监听绑到 ZeroTier 接口，并提供一个手机页面，可以：

- 列出工作区，并按主机路径新建一个；
- 列出会话、在工作区里新建会话、重新打开已有对话；
- 发送 prompt 继续已有对话，或取消正在跑的回合；
- 跟随流式输出、看到工具调用；
- 用一次性配对码配对设备，之后可单独撤销。

**配置平面是刻意不提供的**：没有设置页、没有凭据路由、没有模型 Provider 路由、没有目录选择器。
插件只够得着上面这些动作所需的 Remote 方法，所以已配对的设备能驱动任务，却无法重配 Harness。

## 为什么接口是窄的

Harness Host 自己的 `/api` 路由本来就只信任回环来源，并要求启动 token 或签名会话 cookie。
本插件不碰那条路由、不改 webserver 绑定、也不读 Harness 的会话 cookie：它自己开监听、
用自己的设备令牌鉴权，并以 operator 身份在进程内调用 Remote 方法。

## 配置

所有可调项都在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: zt-remote
  config:
    listenPort: 8790
    interfaceHint: zerotier
    pairCodeTtlSeconds: 600
    deviceTokenDays: 30
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件加载期间是否提供服务。 |
| `listenAddress` | `''` | 显式绑定的 IPv4；留空则自动识别。 |
| `listenPort` | `8790` | TCP 端口。 |
| `interfaceHint` | `zerotier` | 自动识别用的接口名子串（忽略大小写）。 |
| `pairCodeTtlSeconds` | `600` | 一个配对码的有效期。 |
| `deviceTokenDays` | `30` | 签发的设备令牌有效期。 |
| `bodyLimitBytes` | `1048576` | 请求体上限。 |
| `historyPageLimit` | `60` | 每页返回的消息条数。 |
| `stateDir` | `''` | 已配对设备目录；留空用 `$DSH_HOME/plugin-data/dsh-plugin-zt-remote`。 |

自动识别在「没有接口匹配」或「多个接口匹配」时会**拒绝启动**：
一个能执行 shell 的接口，绝不能因为识别失败而放宽到所有网卡。

## 配对

启动后插件会打印配对 URL，并写入 `<stateDir>/pairing.txt`。在手机上打开一次，
页面会把配对码与密钥 POST 到 `/pair`，把返回的令牌存进 `localStorage`。
每个配对码一次性使用且会过期。设备令牌只存 SHA-256 摘要；
`/operator/revoke`（仅限回环调用方）可撤销单台或全部设备。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 手机页面。 |
| GET | `/hello` | 身份与能力。 |
| POST | `/pair` | 用配对码与密钥换设备令牌。 |
| GET | `/workspaces` | 工作区列表。 |
| POST | `/workspaces` | 用 `{ path }` 新建工作区。 |
| GET | `/sessions` | 会话列表。 |
| POST | `/sessions` | 用 `{ workspaceId?, cwd?, agentPreset? }` 新建会话。 |
| GET | `/sessions/:id/messages` | 按消息对齐的历史分页。 |
| POST | `/sessions/:id/prompt` | 用 `{ text, mode? }` 继续对话。 |
| POST | `/sessions/:id/cancel` | 取消正在跑的回合。 |
| GET | `/sessions/:id/events` | SSE：历史快照与后续帧。 |
| GET | `/operator/code`、`/operator/devices` | 仅回环：配对码与设备名册。 |
| POST | `/operator/revoke` | 仅回环：撤销设备。 |

## 安全说明

绑到 ZeroTier 接口意味着该虚拟网络上的每台设备都能连这个端口，
而设备令牌是挡在一个能执行 shell、能改文件的 agent 前面的唯一一道闸。
请把 ZeroTier 网络成员收紧，用撤销＋重新配对来轮换令牌，并把
`pairing.txt` 当成凭据对待。

## 许可

MIT
