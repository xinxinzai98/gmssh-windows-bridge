# GMSSH Windows 局域网端程序（开发预览）

Windows 用户收到新版 `GMSSH-Windows-Setup.exe` 后，双击安装，确认 Windows 管理员提示，在 **GMSSH Windows** 自己的窗口设置并确认连接密码。安装器创建专用本地管理员账号 `gmssh`，同一密码用于 SSH 和桌面，避免依赖使用者现有的微软账号、PIN 或登录密码。安装结束后托盘出现 **GMSSH Windows**。不需另装 Python，不需手动开启 SSH，也不需打开 RustDesk 界面。

此版本面向 Windows 10/11 x64 局域网电脑。安装包带齐官方 OpenSSH MSI、微软 Visual C++ 运行库和校验后的桌面引擎文件，不在被控电脑上从 Windows Update 或 GitHub 下载程序。OpenSSH 分发版本固定为官方 `10.0.0.0p2-Preview`，独立于 Windows 可选功能，由后续 GMSSH 端程序更新负责维护。

## 首次安装自动完成的设置

- 使用包内微软官方 OpenSSH MSI 安装 SSH 服务，执行前验证 SHA-256 和 Windows 程序签名。已有 SSH 配置不会被无提示覆盖。
- 新建专用 `gmssh` 本地管理员账号，使用内置组 SID 加入 Users 和 Administrators，避免中文系统组名差异；密码保持固定、不自动过期。已有同名账号不会被覆盖。使用者原有 Windows 账号和密码不变。
- 设置 `sshd` 自动启动，启用 SFTP 文件互传，默认防火墙仅开放同一子网的 TCP 22；只允许专用账号登录，桌面转发仅允许访问 `127.0.0.1:21118`。文件互传复用 SSH 连接。
- 将官方 RustDesk 1.5.0 中未经修改的原生文件作为内部引擎部署到 `C:\Program Files\GMSSHWindowsBridge\desktop-engine`。它以 Windows 服务运行，不注册单独的 RustDesk 应用入口、主窗口或托盘快捷方式。内部服务保留原引擎名称以维持正常 IPC 和 CLI；第三方许可和来源随包保留。
- 用户在 GMSSH 自己的密码窗口输入固定桌面密码。设置固定密码认证、仅本机回环直连和局域网 SSH 传输；桌面引擎的公共 ID/中继地址设为回环。
- SSH 和桌面服务随 Windows 启动；GMSSH 托盘在该用户登录后启动。
- 输出 `GMSSH-connection.json` 到桌面，包含当前地址、Windows 账号和公开 SSH 主机指纹，不含密码或私钥。

仅调整本次进程的 PowerShell 执行策略，不改变系统或用户的执行策略。

该账号用于整机管理，SSH 终端也具有管理员权限，可以安装程序、改系统设置，以及管理其权限范围内的用户目录和磁盘文件。仍遵循 Windows 文件权限：系统保护目录、显式拒绝访问的目录和其他用户的 EFS 加密文件可能无法访问；安装器不会为此批量修改磁盘权限或文件所有者。远程桌面继续操作当前登录会话，不自动切换到 `gmssh` 的桌面。

## 托盘与基础操作

双击托盘图标打开炭灰色管理面板，查看机器名称、局域网地址、连接账号角色，以及独立的 SSH 和桌面服务状态。面板提供复制公开连接信息、修改密码、启动或停止后台服务；右键菜单保留相同操作和退出托盘。关闭面板或退出托盘后，服务继续运行。

管理面板、密码窗口和安装进度窗口统一使用 GMSSH 品牌资源与蓝紫色操作按钮，尝试使用 Windows 原生暗色标题栏；系统不支持时保留默认标题栏。图标随安装包放入 `C:\Program Files\GMSSHWindowsBridge\brand`，资源缺失时回退到 Windows 系统图标。“本次会话活动”只记录服务状态变化和操作结果，不写入密码，也不代表完整系统事件历史。面板只读说明：键鼠和文本剪贴板通过桌面端，文件通过 SSH，可用性以控制端连接为准；未提供权限开关。

新版完整安装提供“修改连接密码”：通过正常 UAC 请求管理员授权，再打开 GMSSH 自己的密码窗口，同时更新专用 SSH 账号和桌面引擎。密码不写入安装文件、结果 JSON 或日志。桌面引擎官方 CLI 会短暂将密码放入本机进程参数；安装和改密应在受信任的管理员会话中完成。如果引擎拒绝更新，界面明确报告已经更新的 SSH 密码，要求用同一个新密码重试。修改后，控制端下次连接需要更新记住的密码。

## 控制端首次添加

1. Windows 用户把 `GMSSH-connection.json` 的公开信息交给控制端管理员。
2. 控制端按 Windows 输出核对 SSH 公钥指纹，再为这台机器配置本地桥。当前 Mac 开发预览的桥配置和卡片绑定仍需管理员完成，尚未提供连接文件导入向导。
3. 在 GMSSH 添加原生机器：主机填桥的 `127.0.0.1`，端口填这台桥的监听端口，账号填 `gmssh`，输入安装时设置的连接密码并保存。实际 Windows 局域网 IP 配置在桥中。
4. 将蓝色桌面动作绑定同一条原生记录，CPU、内存、磁盘和桌面入口出现在同一张卡片。首次桌面连接输入安装时设置的密码，验证后可保存到控制端钥匙串。

新版完整安装的专用账号与桌面使用同一连接密码；使用者现有 Windows 登录密码和 PIN 保持不变。已有试验机的保留模式仍可以分别使用已有 SSH 和桌面密码。

日常控制端打开配置好的 GMSSH 启动器，点卡片蓝色图标即可进入顶部桌面标签。不需 Windows 用户再次打开独立远控软件。跨子网时网络本身必须可达，安装配置需指定控制端 IP。

## 已有桌面的试验机

只补装 SSH、保留既有桌面密码和设置的专用包使用 `monitorOnly` 配置；也可从完整解压包的管理员 PowerShell 运行：

```powershell
.\setup-windows.ps1 -ExpectedComputer YOUR-PC -WindowsUser your-user -MonitorOnly
```

已完成监控配置后，`-TrayOnly` 可只加 GMSSH 管理托盘并复用已签名的现有桌面引擎，不改变其密码或访问设置。用于现有试验机，不能代替新电脑的全流程验收。


## 验证与回退范围

安装包目前是开发候选。已校验官方分发文件和原生载荷；源代码语法及安装器解压边界检查不等于 Windows 新装、开机、托盘和改密的实机验收。新版管理面板、密码窗口和进度窗口尚需在 Windows 上检查字体、缩放、服务按钮与 UAC 改密。完成这些验收后才能作为正式局域网分发版本。

SSH 配置在 `%ProgramData%\ssh\sshd_config`，局域网规则为 `GMSSH-Windows-Monitor-SSH`。SSH 配置失败时停止服务、取消本次自动启动并禁用新增规则；保留文件供诊断。桌面初始化失败时停止本次新建的桌面服务。既有机器使用专用模式保留原配置。

OpenSSH MSI 安装方式见[微软官方说明](https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/upgrade-in-box-openssh-to-latest-openssh-release)。桌面引擎分发及对应源码见 [RustDesk 1.5.0](https://github.com/rustdesk/rustdesk/releases/tag/1.5.0)；相关 AGPL 及载荷中的依赖许可完整保留。
