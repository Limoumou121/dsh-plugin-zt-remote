# 外部写入清单（工作区之外）

本文件列出这个插件在你的机器上**工作区之外**写入或修改的全部内容。所有路径都经过核对；没有别的隐藏落点。

## 1. `~/.dsh/profiles/desktop/` （安装与配置，可撤销）

| 路径 | 操作 | 由谁写入 | 撤销方式 |
| --- | --- | --- | --- |
| `package.json` | 新增依赖 `dsh-plugin-zt-remote: link:<plugin-dir>`，并把 `dsh-plugin-zt-remote` 加入 `dsh.profile.bundles` | `plugin_manager install_bundle`（官方安装路径） | `plugin_manager remove_bundle` |
| `node_modules/dsh-plugin-zt-remote/` | `link:` 安装产生的链接（指向工作区，不是副本） | pnpm（由 plugin_manager 调用） | 同上 |
| `pnpm-lock.yaml` | 记录该 link 依赖 | pnpm | 同上 |
| `cordis.patch.yml` | 追加一处配置块：`id: zt-remote` → `listenPort: 8790`、`interfaceHint: zerotier`（并把默认值显式化，便于改端口/接口名） | 我在验证 HMR 时写入 | 删除该块即回到插件内置默认值 |
| `cordis.yml` | 由 dsh 自己在每次组装 profile 时重写（空条目列表），非我写入 | dsh | 无需处理 |
| `.plugin-manager/logs/operation-*/pnpm.log` | 安装操作日志 | dsh 插件管理器 | 可删 |

补充说明：`node_modules` 下其余包是你原有的，其中相当一部分是**悬空 junction**，指向已不存在的 `C:\Users\<user>\AppData\Local\Programs\DeepSeek Desktop\...`。我没有改动它们。

## 2. `~/.dsh/plugin-data/dsh-plugin-zt-remote/` （插件运行状态）

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `pairing.txt` | 两行：配对 URL（含一次性 code+secret）+ operator key | 0600 |
| `devices.json` | 已配对设备名册：设备 id、名称、令牌 SHA-256、签发/过期时间。**不含明文令牌** | 0600 |
| `verify-workspace/` | 验收脚本为测试"新建工作区"而创建的目录（插件会拒绝不存在的目录） | 普通目录 |

删除整个目录即清除全部配对与状态；插件下次启动会重新生成。

## 3. `~/.dsh/sessions/` （Harness 自己的会话存储，非插件专有）

验收过程中通过接口创建过一个测试会话，它按 Harness 的正常机制落盘：

```
~/.dsh/sessions/--<workspace-slug>--/session-e015020b-.../session.v4.jsonl.zstd
```

这是插件"新建对话/继续对话"的正确行为，不是额外副作用；不需要可手动删除该目录。

## 4. 网络

| 项 | 说明 |
| --- | --- |
| 监听 | `192.0.2.10:8790`（ZeroTier 网卡），**只绑这一张**；不含 `0.0.0.0`、不含回环 |
| 出站 | 插件自身不发起任何出站连接；模型调用由 Harness 本体负责 |
| 防火墙 | **没有**为你添加任何规则 |

## 5. 没有写入的地方

- 未修改 `<dsh-install>` 安装目录（`app.asar` 及其中的桌面外壳代码）；
- 未修改工作区之外的任何源码；
- 未新增计划任务、服务、注册表项或开机自启；
- 未写入任何凭据文件（`~/.dsh/.credentials.yaml` 未被读取也未被修改）。
