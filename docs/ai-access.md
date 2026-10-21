# AI 接入：管理界面、CLI 与 MCP

0.4.0a27 增加 `gmssh-ai`，0.4.0a28 增加图形化接入，0.4.0a29 增加任务跟进，0.4.0a30 增加精确文本操作，0.4.0a31 补齐本机只读预设和工具范围查询，0.4.0a32 增加服务端文件只读授权及会话中断反馈。CLI/MCP 共用 25 个工具。复用 SSH 或固定证书的 HTTPS 独立授权，不增加 Windows 网络监听端口。AI 设备名单单独启用，不自动读取 GMSSH 机器数据库或导出其中的密码。

已在独立 Windows 测试机完成 14 项直接调用桌面模块的检查；另在已安装服务端上，通过真实 CLI/MCP 验证独立授权、系统查询、文件读取、窗口观察、截图、中文多行输入和正常保存、关闭重开。锁屏拒绝、解锁后的输入、所属弹窗焦点及正常重启后的服务/原 MCP 客户端恢复有实机记录；0.4.0a34 保留卸载重装后，又用原授权完成新文档输入、保存、哈希核对和重开。随后用两份临时文件授权完成 25 项实机权限检查，覆盖降级、原写会话失效、只读写入拒绝、撤销与并发隔离；测试授权均已撤销，原授权保留。后台和任务栏焦点仍受 Windows 保护。详见[验证记录](validation.md)。A4 未操作，Mac 仅切换独立验收客户端。保留服务接入另见[兼容说明](preserve-existing.md)。管理端的[可选系统解锁](windows-unlock.md)不向 CLI/MCP 提供操作系统密码或增加原 AI 授权的权限。

## 激活目标窗口（0.4.0a35）

先调用 `desktop_observe` 获取窗口，再用该窗口的 `desktop_find` 获取新快照，选择原生窗口根节点，向 `desktop_act` 传入 `action: "focus"`。成功后重新观察和查找控件，再输入或点击；不要复用已经消费的快照。该操作仅请求正常激活、恢复最小化窗口，不发送按键或点击任务栏。

此操作仍要求桌面查看与键鼠权限，锁屏、密码框及旧快照检查继续适用。旧服务端没有 `focus` 能力时提示升级；系统拒绝激活时返回 `FOCUS_DENIED`，不会强制修改前台锁定设置。实现使用 Windows 的正常[前台窗口请求](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)。

## 管理端接入面板

首页工具栏点击“AI 接入”，依次完成：

1. 在“添加授权”粘贴 Windows 托盘创建的 `GMSSH-AUTH2.` 独立授权码，核对电脑、地址和主机身份，选择本机允许的能力。默认仅设备信息；选择桌面操作时自动同时选择查看桌面。
2. 保存后在“设备与权限”点击“检查接入”。保存配置不显示为已连接；检查返回真实授权范围、协议与桌面就绪/锁定/暂停等状态，并保留检查时间。该检查不运行命令、不截图，也不验证任意命令是否能够成功执行。
3. 在“接入 AI 客户端”准备所需组件、检查 MCP 启动，再复制通用 JSON、Codex TOML 或 Codex 添加命令。此处不自动修改 AI 客户端配置。组件准备仅安装固定范围的可选 MCP 依赖到该 GMSSH 的 Python 环境，需要联网。

添加和调整权限时，“只读预设”选择设备信息、文件读取和桌面查看，清除文件读写、执行命令和桌面操作；只改变表单，点击启用/保存后才生效。设备列表显示“本机权限：只读”，不代表远端已认证或桌面已就绪。文件读取和文件读写在表单中互斥；选择读写同样包含读取能力。需要命令或键鼠时另外明确勾选，模式会显示为自定义操作。

预设限制后续调用，不中断已经启动的远端任务。检查桌面状态时，锁屏优先报告为 `DESKTOP_LOCKED`，即使用户只允许查看或同时暂停了输入；已解锁时仅暂停输入仍可保留查看能力。

面板绑定当前管理端用户目录下的 `ai-access/`；复制的配置和 CLI 命令自动带上这个目录。独立 CLI 默认目录保持原样，操作图形面板配置时应使用复制内容中的 `--root`，避免混用两个配置目录。

授权码只在密码输入框或主进程中暂存。预览只返回公开身份；保存时网页发送一次性的预览编号，关闭或保存后清除暂存。更新已有授权时必须保持同一设备和授权身份，保留原设备条目；换一个授权身份应另行添加。已有 SSH 设备可更新本机钥匙串密码，Windows 账号密码不变。

本机“停用”阻止新的 AI 操作，不承诺取消已经在远端执行的任务。需要时先单独取消任务，或在 Windows 托盘撤销独立授权。修改本机权限或凭据会使此前检查结果失效；检查结果始终是带时间的观察，后续操作仍重新认证和核对实时权限。

“任务记录”显示这台管理端曾提交或查询过的异步命令，不自动扫描服务端，也不自动连接。选择设备后可刷新本地记录，或明确点击某项“查询远端状态”，通过原授权读取当前状态与一页输出；不会执行原命令。缺少任务编号、已清理的结果或已停用终端权限时不可查询。输出只在当前面板暂存，刷新、切换或关闭后清除，始终按纯文本显示。

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

0.4a31 的本机 `files_read` 允许搜索、读取、内容定位、修改预览及等待文件哈希；保存、替换、创建和恢复仍要求 `files`。旧配置中的 `files` 继续包含全部文件读写，不需要迁移；新 `files_read` 配置需要 0.4a31 或更新的 CLI/MCP。本机只读预设的 CLI 等价操作：

```bash
gmssh-ai configure DEVICE_ID --allow inspect files_read view
gmssh-ai tools DEVICE_ID
```

要让只读限制也由 Windows 强制执行，在 a32 服务端托盘“会话与独立授权”选择“文件仅读取”，或点击“AI 只读预设”再创建/保存授权。该预设允许桌面查看与文件读取，清除写入、终端、输入、剪贴板及电源；仅填充表单，不自动保存。新授权需 a32 或更新的管理端。旧授权的 `files` 仍表示完整读写，更新服务端不会擅自降低或扩大原权限。

服务端逐请求拒绝只读授权的写模式、上传、创建文件夹、修改、重命名和删除，直接调用原始 API 也适用。管理端通过 `fileReadOnly: 1` 核验能力，缺少能力时对新只读授权返回 `SERVER_UPGRADE_REQUIRED`。接入检查的 `features.serverFileAccess` 区分 `read-only`、`read-write`、`denied` 和普通 SSH 的 `ssh-account`；界面区分“服务端文件只读”与“仅本机限制只读”。独立文件中心保留浏览和下载，禁用上传及新建。

服务端关闭文件读写和读取后，本机 `files_read` 同样不能访问。普通 SSH 的只读预设继续只限制本机工具。若另外允许 `terminal` 或 `input`，它们仍能通过命令或 GUI 修改系统；这些通道不是操作系统沙箱。

## MCP 配置

```bash
gmssh-ai mcp-config
```

输出标准 `mcpServers` 配置，使用当前 Python 绝对路径及 `-m gmssh_windows_bridge.ai ... mcp`。自行填入支持 stdio MCP 的客户端；命令不会修改任何客户端设置。独立配置目录可用 `--root /path/to/private-ai`，该目录必须仅当前用户可访问。

0.4a28 还支持以下命令：

```bash
gmssh-ai doctor --check-mcp
gmssh-ai mcp-config --format codex
gmssh-ai mcp-config --format codex-cli
gmssh-ai credential DEVICE_ID
```

`doctor` 只检查本机配置、凭据是否存在和 MCP 工具发现，不连接设备。`credential` 由用户在隐藏输入中更新保存的现有 SSH 密码；独立授权请在面板重新粘贴完整授权码。配置导出不会读取或写入真实凭据值。

Codex TOML 使用 `[mcp_servers.gmssh]`、`command` 和 `args`；需要环境变量的设备仅转发 `env_vars` 名称。格式依据 [OpenAI 官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)与本机 CLI 帮助核对。使用环境变量时请选择 TOML；通用客户端的环境变量传递方式由其自身决定，不在 JSON 中填入密码。添加命令使用 POSIX shell 引号规则，Windows 可直接使用 TOML/JSON 配置。

官方 SDK 处理初始化、工具发现、参数校验和结构化结果。stdout 只承载 MCP，诊断写 stderr。截图通过 MCP image 返回，不在结构化结果中重复大段 base64。

## 工具

| 工具 | 内容 | 本机权限 |
|---|---|---|
| `devices_list` | 已明确启用的设备；不联网、不读凭据 | 无 |
| `device_tools` | 查询本机允许的工具和等待条件；不联网，不代表远端可用 | 至少启用一项本机能力 |
| `device_context` | 系统、Shell/基础工具、磁盘、桌面状态与有效能力 | `inspect`，桌面状态另需 `view` |
| `device_access_check` | 认证、有效权限、协议与桌面状态；结果有检查时间，不运行命令或截图 | 至少启用一项本机能力 |
| `system_query` | 进程、服务、限时 Windows 事件日志 | `inspect` |
| `powershell_run` | 任意 PowerShell；独立授权返回持久任务编号 | `terminal` |
| `task_get` / `task_cancel` / `task_forget` | 分页输出、取消、清理结束任务 | `terminal` |
| `tasks_list` | 本地近期回执，不联网；状态为带时间的观察 | `terminal` |
| `task_wait` | 等待已有任务，最多 60 秒，返回一页输出 | `terminal` |
| `desktop_observe` / `desktop_find` | 窗口、UIA 树、按名称/类型/AutomationId 查找 | `view` |
| `desktop_screenshot` | 已解锁桌面截图，最大 1600×1000 | `view` |
| `desktop_act` | Invoke/SetValue、控件中心点击、Unicode 输入、有限按键组合 | `view` + `input` |
| `wait_for` | 控件出现/消失、服务状态、文本文件哈希 | 按条件检查 `view` / `inspect` / `files_read` |
| `files_search` / `files_read` | 文件名搜索、UTF-8 分段读取、完整 SHA-256 | `files_read` 或 `files` |
| `files_find_text` | 在指定文本文件中按字面量找内容，返回行号、列号和有界上下文 | `files_read` 或 `files` |
| `files_preview` / `files_replace_preview` | 全文或唯一片段的修改预览，不保存内容 | `files_read` 或 `files` |
| `files_replace` | 核验哈希后替换唯一片段并保留备份 | `files` |
| `files_create` | 校验暂存内容后创建新文本；已有目标不覆盖 | `files` |
| `files_apply` / `files_restore` | 核对哈希后保存、备份恢复 | `files` |

CLI 与 MCP 使用相同参数：

```bash
gmssh-ai context DEVICE_ID
gmssh-ai tools DEVICE_ID
gmssh-ai run DEVICE_ID --script-file /path/to/check.ps1 --timeout 300 \
  --request-key 11111111111111111111111111111111
gmssh-ai task DEVICE_ID TASK_ID
gmssh-ai task DEVICE_ID TASK_ID --wait 30
gmssh-ai tasks DEVICE_ID --limit 100
gmssh-ai cancel DEVICE_ID TASK_ID
gmssh-ai call desktop_find --arguments \
  '{"device":"DEVICE_ID","window":"12345","name":"保存"}'
```

替换示例中的设备/任务编号和窗口句柄：设备编号来自 `devices`，句柄来自 `desktop_observe`。每个新命令用新请求键；同一命令重试保留原键。

AI 可先调用 `devices_list`，再用 `device_tools` 查看某台设备的本机工具范围。结果的 `scope` 固定为 `local-policy`、`remoteStateChecked: false`，`readOnly` 按本机允许的工具是否包含修改操作计算；`wait_for` 另外列出允许的条件。目录读取不访问凭据或设备，停用的设备拒绝查询。需要确认当前认证、服务端通道及桌面状态时，再调用 `device_access_check`。每次实际操作仍独立检查权限；全局 MCP 工具发现保持完整，不把曾发现某个工具视为该设备已获得授权。

## 结果、任务与断线

统一结果包含 `schema`、`ok`、`tool`、`device`、`sampledAt` 及 `result`/稳定错误码。`ok` 表示工具请求成功；业务是否完成需检查任务 `state`、`exitCode` 或等待结果 `matched`。

独立授权任务保存在 Windows 受限目录，用现有 DPAPI 加密。CLI/MCP 退出后可凭任务编号继续查询；服务本身中断时，运行任务标为 `OUTCOME_UNKNOWN`，不自动执行第二次。记录不保存命令正文，保留命令摘要、退出码和有界输出；输出可能含敏感信息，所以一并加密。

请求键绑定授权、命令和超时。同键同参数返回原任务，不同参数报 `IDEMPOTENCY_CONFLICT`。启动响应丢失时，错误中保留 `requestKey`；核对原任务应沿用它。最多保留 128 项结果、同时运行 4 项；`task_forget` 清理已结束结果。结果仅创建它的独立授权可读；撤销授权或修改权限取消其运行任务。

控制端提交前先将请求键写入私有 `ai-tasks.json`；不能保存恢复信息时不提交新命令。已取得任务编号后保存上次观察的状态、退出码和时间，查询及取消同样更新这份元数据。文件不保存脚本、输出、密码或授权 token，不参与源码导出与设备配置备份。重开客户端后，`tasks_list` 或“任务记录”仍能找到这些编号；它们不代表设备目前在线，也不是服务端全部任务。SSH 同步执行不进入该列表。

全局最多保留近期 200 项本地回执，超限移出最旧的本地记录，并返回 `pruned: true`；不清理服务端任务。回执按设备及独立授权身份隔离。提交响应丢失的记录只保留请求键，标记“结果未知”；需用户决定是否沿用原请求键、原脚本与原超时核对，不自动重放。已知远端结果不会因为随后本地落盘失败而隐藏，此时另附 `localJournal` 警告。

`task_wait` 只轮询已有任务。返回 `finished: true` 表示进入结束状态，包括非零退出、取消和结果未知等，仍应核对 `state`、`code`、`exitCode`。等到指定时限仍在运行时，返回 `finished: false`、`waitTimedOut: true`，不取消任务，不把等待超时当作远端失败。每次仍最多返回 16 KiB 输出；`more: true` 时用返回的 `nextOffset` 继续 `task_get`，无需重复执行命令。连接或权限错误直接返回，不自动重连或提交新任务。

独立授权命令最长 3600 秒，输出最多 256 KiB、每页 16 KiB；运行时可查状态，输出在执行结束后读取。偏移按 UTF-8 字节计算，沿用返回的 `nextOffset`。当前合并 stdout/stderr，明确返回 `combinedOutput: true`；退出码来自实际 PowerShell 进程。取消不撤销已有影响，也不保证终止其创建的所有外部程序。`task_forget` 同时清除该任务的去重记录，清理后不再复用其请求键。

SSH 为最多 60 秒的同步命令，分别返回 stdout/stderr 和退出码，不宣称支持持久异步任务。长任务和 UIA 需要新版 Windows 服务端及独立授权；旧版返回 `SERVER_UPGRADE_REQUIRED`，不会自动升级。

a32 的服务端撤销、权限修改和单会话断开会立即阻止新的与排队的会话请求，然后在后台释放资源；托盘在释放完成前显示“正在结束”。清理等待中的会话继续计入总会话上限，不能绕过限制。它不撤销已经发生的修改，也不保证中断所有外部程序。关闭后完成的文件请求返回 `SESSION_CLOSED`，被中断的单次命令返回 `OPERATION_INTERRUPTED`，等待响应超时返回 `OPERATION_TIMEOUT`。管理端不自动重放写入或命令；先读取原文件、查询原任务或重新观察桌面，再决定后续操作。

独立 Windows 的实机验收步骤见[AI 原生验收清单](ai-native-acceptance.md)。测试机可用虚拟机或闲置实体电脑；日常使用不需要虚拟机。原生桌面模块已完成 14 项实际检查；完整服务端部署与 AI 客户端链路仍按清单分别验收。

## 桌面操作

UIA 工作者由托盘在已登录用户会话启动。SYSTEM 服务经具有用户/SYSTEM ACL 的本机命名管道转发固定操作，不在 Session 0 输入，也不接收任意脚本路径。当前只选活动控制台会话，不自动选择 RDP 或其他用户会话。

先列窗口，再指定窗口观察/查找。最多扫描 250 个节点、深度 5，不完整结果标记 `truncated`。控件快照仅本授权可用，30 秒有效。操作前核对运行时标识、进程、名称、类型及 AutomationId；键鼠操作另检查位置、置前窗口和输入焦点。操作后快照失效，需重新观察；同名控件返回独立编号，不默选第一个。

文本有长度上限，密码框不回传内容，也不自动填写。中文使用 Unicode 输入，不改剪贴板。输入按授权短暂串行占用。Windows 托盘可“暂停 AI 桌面控制”，仍可查看。UIA 调用超时会结束该工作者，由托盘重新准备；响应未知时先重新观察，不能盲目重试。

等待复用真实观察与查询。失败、锁屏或遍历截断不算控件消失；超时返回 `matched: false`。动作回执只表示已提交，需另行验证业务结果。

UIA 能力取决于应用。UAC、安全桌面、锁屏及缺少 UIA 的自绘界面不在此轮保证范围。截图包含屏幕可见内容，按需返回、不默认留存。目前未提供任意屏幕坐标点击、录屏及应用专用 COM/DOM 接口。

## 文件与权限

文本文件最多 1 MiB、一次最多 200 行/32 KiB。搜索最多 200 个结果、2000 个目录项和 4 层递归，不跟随符号链接；独立授权沿用服务端 reparse point 检查。普通 SSH 的链接识别受其 SFTP 实现影响。超长行和差异截断有明确标记。

`files_read` 返回 `startByte`、`nextByte`、`eof` 和完整文件 `sha256`。长单行超过一页时，下一次传 `startByte: 上次的 nextByte`、`expectedSha256: 上次的 sha256`，可一直读到 `nextByte: null`，不会跳过行内剩余内容或拆开中文/emoji。偏移是原文件的 UTF-8 字节，包含可能存在的 BOM；首屏不显示 BOM。续读只接受字符边界，非零偏移必须带哈希，源文件变化就停止。字节模式不能与 `startLine`/`limit` 混用；普通按行翻页可继续用 `nextLine`，同样可携带 `expectedSha256`。

`files_find_text` 在明确指定的单个 UTF-8 文件内定位，区分大小写，不解释正则或执行命令，也不扫描其他目录。`query` 是非空单行字面量、最多 256 UTF-8 字节；每个匹配行返回第一个匹配的行号/列号和前后各至多 32 个字符。列号按 Unicode 字符从 1 起计；片段可能只覆盖长行的一部分，`textStartColumn` 标明片段起点。单页最多 100 行匹配，上下文合计不超过 16 KiB；`nextLine` 表示还有未扫描的行，不保证后面仍有匹配。继续查询时带回完整文件的 `expectedSha256`，避免拼接不同版本。

修改少量配置时，可先用 `files_replace_preview`，再用相同参数调用 `files_replace`。两者均要求 `path`、`oldText`、`newText` 和 `expectedSha256`。原文必须恰好出现一次，包含重叠匹配的重复也会停止；不提供“全部替换”。片段各最多 32 KiB UTF-8，新内容可为空。保存复用原有的哈希复核、临时文件校验、不覆盖重命名及备份恢复，不需要把整个文件重新发送给模型。保留现有 UTF-8 BOM 和替换范围外的原有换行；若原文未找到，应读取真实的 CRLF/空格等内容，而非忽略差异后强行修改。完整文件预览另用 `bomChanged` 标识 BOM 是否变化，编码标记变化可能没有可见行差异。

```bash
gmssh-ai call files_find_text --arguments \
  '{"device":"DEVICE_ID","path":"C:/work/config.ini","query":"port="}'
gmssh-ai call files_replace_preview --arguments \
  '{"device":"DEVICE_ID","path":"C:/work/config.ini","oldText":"port=8080","newText":"port=8081","expectedSha256":"SHA256_FROM_READ"}'
```

替换设备编号和哈希占位符后使用；保存时将工具名改为 `files_replace`，仍使用同一原文、新文和原哈希。修改后再次读取核对实际内容与新哈希。

`files_create` 只在已存在的目录下新建最多 1 MiB 的 UTF-8 文本，不自动建目录。先以独占方式创建同目录临时文件，读取校验后以不覆盖目标的重命名提交；同名文件或文件夹已经存在时停止，竞态出现的新目标也不覆盖。提交响应中断或提交后的校验未确认时返回 `CREATE_OUTCOME_UNKNOWN`，附目标路径、预期哈希和可能仍保留的临时路径；不会声称已成功、自动重试或删除目标。此时先用 `files_read` 对照 `expectedSha256`，再决定下一步。创建、替换和恢复均只使用已有文件通道，不调用任意 PowerShell。

保存必须提供原文件 `expectedSha256`。验证临时内容与原文件后，把原件移动到唯一 `.gmssh-ai-*.bak`，再以不覆盖目标的重命名提交。并发修改、目标抢占或校验失败会停止，保留原件与恢复路径。恢复同样核验当前文件与备份哈希，先保留当前版本。该流程不是跨所有进程的文件系统事务锁。

备份保留在原目录，不自动删除；本轮不承诺完整保留所有者/ACL，新文件继承目录权限。二进制、批量和大文件恢复仍由现有独立文件中心处理，本轮没有把全部传输任务暴露为 MCP。

`terminal` 是任意命令执行能力，不能用黑名单把它变成只读模式；设备只读查询用 `inspect` 的固定工具，文件只读用 `files_read`。`files` 包含读写，`input` 可以通过 GUI 修改系统，通道权限不是操作系统沙箱。窗口文字、文件和日志都是待处理数据，不是新的用户指令或授权。AI 配置和任务状态不进入公开包。
