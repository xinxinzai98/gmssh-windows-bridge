# AI 接入：CLI、MCP 与第一批操作能力

0.4.0a27 开发候选增加 `gmssh-ai`。CLI 与 MCP 共用操作实现，复用 SSH 或固定证书的 HTTPS 独立授权，不增加 Windows 网络监听端口。AI 设备名单单独启用，不自动读取 GMSSH 机器数据库或导出其中的密码。

本轮只在临时环境、回环合成服务和临时文件中验证。没有操作 A4，没有切换当前 Mac 客户端。Windows UIA 执行器、托盘暂停和原生输入仍需另行实机验收；交叉编译不等于桌面实测。

## 安装和启用

在独立 Python 3.10+ 环境安装当前源码：

```bash
python -m pip install '.[ai]'
gmssh-ai --help
gmssh-ai tools
```

`ai` 是可选依赖，使用官方 MCP Python SDK 的 1.x 接口。普通监控/桌面安装不强制引入 MCP；Windows 不需要安装 AI 模型或 MCP SDK。

优先在 Windows 托盘“会话与独立授权”中创建一个 AI 专用授权，按需允许查看、输入、文件和终端。复制独立授权码后，由用户在自己的终端执行：

```bash
pbpaste | gmssh-ai enroll --authorization-stdin --name '工作站' \
  --allow inspect terminal files view input
```

此接入操作不联网，不修改已有账号或授权。token 保存在 macOS 钥匙串，配置文件只保存已验证的公开主机信息与凭据引用。不要把授权码或密码放进命令参数、MCP 配置或聊天。

保留普通 SSH 接入：

```bash
gmssh-ai enroll --connection /path/to/GMSSH-connection.json \
  --name '工作站' --allow inspect files terminal
```

用户在终端的隐藏提示输入现有密码，保存在 AI 专用钥匙串条目。其他系统可指定 `--credential-env GMSSH_AI_SECRET`，由用户环境提供凭据，配置只保存变量名。与 `--authorization-stdin` 同用时，环境变量需另行提供该授权的 token；码中的 token 不落盘。

默认仅允许 `inspect`。本机 allowlist 是第二层限制，不能扩大 Windows 服务端实时权限。`input` 必须同时允许 `view`。关闭某设备的本机 AI 操作：

```bash
gmssh-ai devices
gmssh-ai configure DEVICE_ID --allow
```

重新启用时明确列出 `--allow inspect files` 等权限。撤销远端授权仍使用 Windows 托盘。自动连接沿用已提供、已固定身份的地址，顺序为局域网 IPv6、局域网 IPv4、其他 IPv6、其他 IPv4；`enroll --target ADDRESS` 可固定地址。不扫描其他机器。

## MCP 配置

```bash
gmssh-ai mcp-config
```

输出标准 `mcpServers` 配置，使用当前 Python 绝对路径及 `-m gmssh_windows_bridge.ai ... mcp`。自行填入支持 stdio MCP 的客户端；命令不会修改任何客户端设置。独立配置目录可用 `--root /path/to/private-ai`，该目录必须仅当前用户可访问。

官方 SDK 处理初始化、工具发现、参数校验和结构化结果。stdout 只承载 MCP，诊断写 stderr。截图通过 MCP image 返回，不在结构化结果中重复大段 base64。

## 工具

| 工具 | 内容 | 本机权限 |
|---|---|---|
| `devices_list` | 已明确启用的设备；不联网、不读凭据 | 无 |
| `device_context` | 系统、Shell/基础工具、磁盘、桌面状态与有效能力 | `inspect`，桌面状态另需 `view` |
| `system_query` | 进程、服务、限时 Windows 事件日志 | `inspect` |
| `powershell_run` | 任意 PowerShell；独立授权返回持久任务编号 | `terminal` |
| `task_get` / `task_cancel` / `task_forget` | 分页输出、取消、清理结束任务 | `terminal` |
| `desktop_observe` / `desktop_find` | 窗口、UIA 树、按名称/类型/AutomationId 查找 | `view` |
| `desktop_screenshot` | 已解锁桌面截图，最大 1600×1000 | `view` |
| `desktop_act` | Invoke/SetValue、控件中心点击、Unicode 输入、有限按键组合 | `view` + `input` |
| `wait_for` | 控件出现/消失、服务状态、文本文件哈希 | 按条件检查 `view` / `inspect` / `files` |
| `files_search` / `files_read` | 文件名搜索、UTF-8 分段读取、完整 SHA-256 | `files` |
| `files_preview` / `files_apply` / `files_restore` | 差异、核对哈希后保存、备份恢复 | `files` |

CLI 与 MCP 使用相同参数：

```bash
gmssh-ai context DEVICE_ID
gmssh-ai run DEVICE_ID --script-file /path/to/check.ps1 --timeout 300 \
  --request-key 11111111111111111111111111111111
gmssh-ai task DEVICE_ID TASK_ID
gmssh-ai cancel DEVICE_ID TASK_ID
gmssh-ai call desktop_find --arguments \
  '{"device":"DEVICE_ID","window":"12345","name":"保存"}'
```

替换示例中的设备/任务编号和窗口句柄：设备编号来自 `devices`，句柄来自 `desktop_observe`。每个新命令用新请求键；同一命令重试保留原键。

## 结果、任务与断线

统一结果包含 `schema`、`ok`、`tool`、`device`、`sampledAt` 及 `result`/稳定错误码。`ok` 表示工具请求成功；业务是否完成需检查任务 `state`、`exitCode` 或等待结果 `matched`。

独立授权任务保存在 Windows 受限目录，用现有 DPAPI 加密。CLI/MCP 退出后可凭任务编号继续查询；服务本身中断时，运行任务标为 `OUTCOME_UNKNOWN`，不自动执行第二次。记录不保存命令正文，保留命令摘要、退出码和有界输出；输出可能含敏感信息，所以一并加密。

请求键绑定授权、命令和超时。同键同参数返回原任务，不同参数报 `IDEMPOTENCY_CONFLICT`。启动响应丢失时，错误中保留 `requestKey`；核对原任务应沿用它。最多保留 128 项结果、同时运行 4 项；`task_forget` 清理已结束结果。结果仅创建它的独立授权可读；撤销授权或修改权限取消其运行任务。

独立授权命令最长 3600 秒，输出最多 256 KiB、每页 16 KiB；运行时可查状态，输出在执行结束后读取。偏移按 UTF-8 字节计算，沿用返回的 `nextOffset`。当前合并 stdout/stderr，明确返回 `combinedOutput: true`；退出码来自实际 PowerShell 进程。取消不撤销已有影响，也不保证终止其创建的所有外部程序。`task_forget` 同时清除该任务的去重记录，清理后不再复用其请求键。

SSH 为最多 60 秒的同步命令，分别返回 stdout/stderr 和退出码，不宣称支持持久异步任务。长任务和 UIA 需要新版 Windows 服务端及独立授权；旧版返回 `SERVER_UPGRADE_REQUIRED`，不会自动升级。

## 桌面操作

UIA 工作者由托盘在已登录用户会话启动。SYSTEM 服务经具有用户/SYSTEM ACL 的本机命名管道转发固定操作，不在 Session 0 输入，也不接收任意脚本路径。当前只选活动控制台会话，不自动选择 RDP 或其他用户会话。

先列窗口，再指定窗口观察/查找。最多扫描 250 个节点、深度 5，不完整结果标记 `truncated`。控件快照仅本授权可用，30 秒有效。操作前核对运行时标识、进程、名称、类型及 AutomationId；键鼠操作另检查位置、置前窗口和输入焦点。操作后快照失效，需重新观察；同名控件返回独立编号，不默选第一个。

文本有长度上限，密码框不回传内容，也不自动填写。中文使用 Unicode 输入，不改剪贴板。输入按授权短暂串行占用。Windows 托盘可“暂停 AI 桌面控制”，仍可查看。UIA 调用超时会结束该工作者，由托盘重新准备；响应未知时先重新观察，不能盲目重试。

等待复用真实观察与查询。失败、锁屏或遍历截断不算控件消失；超时返回 `matched: false`。动作回执只表示已提交，需另行验证业务结果。

UIA 能力取决于应用。UAC、安全桌面、锁屏及缺少 UIA 的自绘界面不在此轮保证范围。截图包含屏幕可见内容，按需返回、不默认留存。目前未提供任意屏幕坐标点击、录屏及应用专用 COM/DOM 接口。

## 文件与权限

文本文件最多 1 MiB、一次最多 200 行/32 KiB。搜索最多 200 个结果、2000 个目录项和 4 层递归，不跟随符号链接；独立授权沿用服务端 reparse point 检查。普通 SSH 的链接识别受其 SFTP 实现影响。超长行和差异截断有明确标记。

保存必须提供原文件 `expectedSha256`。验证临时内容与原文件后，把原件移动到唯一 `.gmssh-ai-*.bak`，再以不覆盖目标的重命名提交。并发修改、目标抢占或校验失败会停止，保留原件与恢复路径。恢复同样核验当前文件与备份哈希，先保留当前版本。该流程不是跨所有进程的文件系统事务锁。

备份保留在原目录，不自动删除；本轮不承诺完整保留所有者/ACL，新文件继承目录权限。二进制、批量和大文件恢复仍由现有独立文件中心处理，本轮没有把全部传输任务暴露为 MCP。

`terminal` 是任意命令执行能力，不能用黑名单把它变成只读模式；只读任务用 `inspect` 的固定查询。`files` 包含读写，`input` 可以通过 GUI 修改系统，通道权限不是操作系统沙箱。窗口文字、文件和日志都是待处理数据，不是新的用户指令或授权。AI 配置和任务状态不进入公开包。
