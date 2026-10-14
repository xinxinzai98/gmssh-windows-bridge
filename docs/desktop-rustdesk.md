# 免费 RustDesk 桌面接入（0.4.0a5 实验版）

用户选择在 GMSSH 页面中显示并操作 Windows 的真实桌面，并优先使用免费方案。产品按局域网设计：填写 Windows IP 或可解析主机名，查看器经已验证主机密钥的 SSH 隧道访问 Windows RustDesk。无需 RustDesk Server Pro、独立 ID/中继服务器或 VPN。

```text
GMSSH 网页容器 / 浏览器
    → 本机回环 WebSocket
    → Windows OpenSSH（原有账号，校验 known_hosts）
    → Windows 的 127.0.0.1:21118
    → RustDesk 直接 IP 协议 → 用户桌面
```

## 当前完成范围

浏览器组件采用 Kessoku 项目的 MIT 协议编解码、VP9 WebCodecs 解码与基本键盘辅助代码。原始出处固定在 `desktop-web/vendor/UPSTREAM.md`，保留 MIT 和 Protobuf 依赖的完整许可。连接状态机、本地 SSH 传输及页面为本项目新增代码，不包含 RustDesk 商业 Web V2 资源，也没有引入 Kessoku 的账号、数据库、ID 或中继服务栈。

已有实机验证包括密码挑战、VP9 画面、鼠标、基本键盘、主动断开和顶部标签切换。0.4.0a5 新增显示器切换、画质/缩放、常用组合键、中文文本发送、文本剪贴板和 SSH 文件侧栏；这些新增能力已实现并通过相应模拟检查，尚需在目标 Windows 复核。需要支持 VP9 WebCodecs 的现代 Chromium 安全上下文。

文件侧栏经同一台电脑已认证的 SSH/SFTP 浏览磁盘、上传和下载单文件，上限 512 MiB；上传不覆盖已有文件，失败或取消时清理本次临时文件。下载在浏览器内存中组装；没有文件夹递归、断点续传或后台传输队列。原生终端继续使用 GMSSH 原处理，通过兼容桥进入 PowerShell。

桌面提供锁屏和 Ctrl+Alt+Del。重启/关机需确认目标，在控制端倒计时 30 秒后发送固定 Windows 命令；取消倒计时或关闭电源面板/页面不会发送该命令。服务只报告请求结果，不把请求发送视为设备已经重启/关闭。本轮没有实际执行这些电源操作。

局域网唤醒可通过启动器的 `--wake-mac` 和 `--wake-broadcast` 配置，使用安装记录中公开的物理网卡信息核对目标，广播地址必须是控制端实际接入子网的广播地址。当前只支持以 `.255` 结尾的私有 IPv4；未配置时按钮禁用。发送 UDP 9 魔术包不需要目标 SSH 在线，但需要同一局域网以及已启用的 BIOS/NIC/供电支持，未实机验证。

文本剪贴板在用户点击读取/复制后访问本机剪贴板，支持 RustDesk 1.5 的 `Clipboard` 和 `MultiClipboards` 文本消息及有上限的 zstd 解压。音频、录制、隐私屏幕、远程打印和剪贴板文件尚未实现。UAC/安全桌面、真实中文输入法及长时间运行仍待验收。

这是 **0.4.0a5 开发候选**。已有的 0.3.0 继续提供终端、SFTP 和监控；本版的代码、浏览器模拟界面和原生/设备验收分别记录在 [验证记录](validation.md)。

## macOS 自动入口

首次安装 `[desktop]` 构建包后，使用安装了本包的 Python 运行环境生成本机启动器：

Python 运行环境和日常使用的 `.app` 应放在不参与云端按需下载的本机目录，例如 `~/Library/Application Support/gmssh-windows-bridge/` 和 `~/Applications/`。不要直接使用 iCloud 文稿、桌面中的构建环境作为长期运行环境：已验证的依赖也可能随后被卸载为占位文件，导致下一次启动等待下载而超时。源码和分发包仍可保留在同步目录。

```bash
gmssh-windows-launcher --output "$HOME/Applications/Windows Desktop.app" \
  --target 192.168.1.50 --monitor-port 22244 --monitor-username windows-user \
  --monitor-known-hosts /path/to/verified-known-hosts \
  --monitor-host-key /path/to/dedicated-bridge-host-key \
  --machine-id exact-gmssh-machine-id --keychain
```

`--target` 支持 Windows IP 或主机名。先核对并固定 Windows 的 SSH 公钥，GMSSH 原生卡片连接本机监控端口，使用现有 Windows 账号认证。监控和桌面运行在同一个桥进程：桌面只借用这个目标已认证的 SSH 连接，允许转发到 Windows 的 `127.0.0.1:21118`。无需在查看器再次输入 SSH 密码；没有可用监控认证时会提示先连接监控。

监控请求结束时，正在使用的桌面连接可以继续；关闭最后一个使用者后释放上游 SSH。退出启动器会关闭本机桥。默认监控仍拒绝任意命令、终端和 SFTP；需要它们时应另外显式启用相应功能。

启动器适用于当前 Mac 已安装的 GMSSH 2.0.4。它启动本地查看器，再加载 GMSSH 页面并自动打开 Windows 桌面标签；标签位于首页旁，与原生终端/桌面标签同排。切换标签保留 iframe 和会话，关闭标签或点击“断开”才结束连接。关闭后点击对应机器卡片原有的蓝色桌面图标重开；退出启动器关闭本地查看器。首次切换需正常退出原 GMSSH，以免两个实例争用机器仓库。

已有 GMSSH 监控记录通过准确的 `--machine-id` 绑定。入口监听原有 `[data-machine-action="desktop"]`，只把指定机器分流到配置的 Windows 查看器；其他机器继续执行 GMSSH 原处理逻辑。卡片和原生表格中的同一动作都可复用，不另加悬浮按钮，也不会把所有机器指向同一个 Windows。

没有监控记录时，启动器根据明确配置的设备名称和地址显示一张桌面专用卡片，复用相同的蓝色图标和事件入口；卡片标明尚未接入监控，不伪造 CPU、内存或在线状态。它不写入 GMSSH 的 SSH 账号库，不属于原生监控机器计数。当前启动器仍配置一台 Windows，其他 Windows 需逐台明确绑定，不能仅凭操作系统图标猜测远程地址。

这是页面级标签扩展，当前未接入 GMSSH 原生标签拖动、概览列表和切换快捷键。布局更新可用 `preserveSession: true` 保留同一个查看器；只在查看器来源和路径相同时采用原 iframe。

启动器只在自己的 `.app` 中添加代码、签名和克隆运行框架，不写入原安装包。它保持 ASAR 完整性校验，未启用调试端口或开发控制台；GMSSH 登录协议处理器仍由原安装包提供。启动器依赖本机已安装 GMSSH 和配置的 Python 运行环境，适合作为个人开发预览，不是可跨机器分发的完整 GMSSH 客户端。官方 GMSSH 更新后需重新核对适配。

推荐首次安装设置固定桌面密码，首次连接输入一次并记住。启用 `--keychain` 时，“记住 RustDesk 密码（本机钥匙串）”默认勾选，可取消；只有输入密码并通过 RustDesk 认证后才保存。条目绑定确切 SSH 目标、账号和端口，Mac 端桌面密码不进入命令行、配置文件或日志。后续启动读取此条目自动认证。Windows SSH 账号密码由 GMSSH 正常认证，本桥不另行保存。临时桌面密码过期、钥匙串访问失败或远端设置要求批准时仍需认证。

钥匙串模式为每次启动生成随机的本机会话令牌。启动器在内存中接收它，再发送给对应 iframe，令牌不放入桌面标签地址或配置文件。WebSocket 在连接 Windows、读取或写入记住的密码之前校验令牌；只有正确 Origin 仍不足以获得访问权。单独用 CLI 启动钥匙串模式时，应使用输出的完整本地链接，其中的临时授权片段不要分享；打开后查看器会从地址栏移除它。

`--profile` 仅改变 Electron 浏览器配置目录；GMSSH 本地服务仍可能读取已有机器仓库，不能用它保证账号或机器隔离。日常启动器不使用此参数。

## Windows 首次固定密码配置

`GMSSH-Windows-Setup.exe` 是局域网首次安装的统一入口，解压包内载荷并调用 `setup-windows.ps1`。它离线安装官方 OpenSSH MSI，部署未修改的内部桌面引擎，设置自动启动和 GMSSH 托盘。UAC 和新密码输入由使用者完成正常确认。详见 [Windows 首次接入](windows-first-run.md)。

`gmssh_windows_bridge/setup-desktop.ps1` 是其中的固定密码配置步骤，要求受信任的桌面引擎、运行中的服务和有效的程序签名。新电脑使用内部引擎；已有测试机可复用正式安装的原引擎。

先在 Windows 检查，不更改配置：

```powershell
powershell.exe -NoProfile -File .\setup-desktop.ps1 -SelfTest
powershell.exe -NoProfile -File .\setup-desktop.ps1 -CheckOnly
```

首次桌面配置时，操作者确认设备和影响，输入自定义密码并再次确认。脚本通过 RustDesk 官方 CLI 设置固定密码、仅使用固定密码认证、启用 21118 直接访问，并将白名单限定为本机回环。配置项逐项回读，不改 Windows 账号密码。SSH 和局域网防火墙由单独的 `setup-monitor.ps1` 步骤配置。

该流程用于初始化新电脑。白名单会限制原有局域网或公共 ID 连接，不能直接作为已部署机器的无提示升级。密码不写入脚本或结果文件；官方 `--password` 接口会短暂把密码放入 Windows 进程参数，因此应由操作者在受信任的本机管理员会话完成。若系统审计进程参数，使用 RustDesk 正常的密码设置界面。

配置完成后，GMSSH 首次桌面连接输入相同的固定密码，认证成功再保存到钥匙串。完整 Windows 新装流程与已有机器的监控补装仍需各自实机验收。

## 启动

使用带桌面静态资源的构建包，安装可选依赖：

```bash
python -m pip install '.[desktop]'
```

随现有桥启动：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --known-hosts /path/to/trusted-known-hosts \
  --gmssh-terminal --shell powershell --desktop-port 22240 --background
```

浏览器打开 `http://127.0.0.1:22240/`。SSH 入口的端口仍由 `--listen-port` 控制，两者必须不同。桌面窗口需分别验证原有 Windows SSH 密码和 RustDesk 密码；RustDesk 密码留空时可在 Windows 端确认连接，最多等待 5 分钟。页面会清空密码输入，不保存凭据。状态区区分 SSH 验证、RustDesk 登录请求和实际收到画面。

也可以独立测试桌面服务：

```bash
gmssh-windows-desktop --target windows-host --username windows-user \
  --known-hosts /path/to/trusted-known-hosts --listen-port 22240
```

默认 RustDesk 目标端口为 `21118`，可通过 `--rustdesk-port` 指定该 Windows 主机上的另一个直接访问端口。此参数由启动者配置，网页不能改写目标主机、账号或端口。

Windows 上需要 RustDesk 程序已启动、直接 IP 访问已启用，并能访问真实用户桌面；SSH 需允许转发到该本机端口。本桥不自动安装程序、修改 RustDesk 认证、启用端口或开放防火墙。RustDesk 的监听范围和服务模式需在 Windows 部署时单独核对。

## GMSSH 临时入口

GMSSH SDK 提供自定义网页窗口，纯前端应用无需 `init()` 启动服务。服务的 `frame-ancestors` 允许本机回环和 `file:` 来源；本轮使用实际 GMSSH 页面中的 iframe 完成了画面和基本输入联调。

在 2.0.4 的公开 SDK 中未找到按机器替换原生“桌面”按钮的接口。`desktop-web/public/gmssh-entry.js` 提供当前页面内的临时挂接：只拦截指定机器的桌面按钮，在可关闭的 iframe 面板中加载回环查看器。它不修改 GMSSH 安装包、不部署 Linux Agent，也不读取账号数据。刷新页面或重启客户端后，需要重新激活。

先审阅该脚本，再从 GMSSH 的 `View → Toggle Developer Tools → Console` 激活。开发控制台如果显示粘贴安全警告，应由操作者亲自处理。页面没有 Node.js 的 `require`；桌面服务通过 HTTP 提供同一份通用脚本，使用标准浏览器加载方式：

```javascript
(() => {
  const script = document.createElement("script");
  script.src = "http://127.0.0.1:22240/gmssh-entry.js";
  script.onload = () => installWindowsDesktopEntry({
    machineId: "your-windows-machine-id",
    viewerUrl: "http://127.0.0.1:22240/",
  }).open();
  document.head.append(script);
})();
```

必须使用机器记录的准确 ID；这里的占位值不能直接使用。`removeWindowsDesktopEntry()` 可恢复当前页面的按钮行为并关闭面板。不同 GMSSH 版本可能不提供所需的 `data-machine-id` / `data-machine-action` 属性，正式使用前需验证实际页面。先前的 `examples/rustdesk-desktop/index.html` 只演示 iframe 承载，不是本版选定的免费协议客户端。

## 验证与完成条件

自动检查覆盖既有终端、SFTP、后台运行，以及桌面分帧、双向传输、来源/Host/路径限制、目标主机密钥验证和两个本地监听的后台启动。本地浏览器协议模拟器通过了独立密码向量验证、三个 VP9 测试帧、视频 ACK、鼠标按下/抬起和键盘按下/抬起；模拟画面明确标注为测试，不是 Windows 桌面。

2026-10-12，在已授权的 Windows 11 试验机安装官方 RustDesk 1.5.0（安装文件哈希匹配、Authenticode 签名有效），回读服务运行和直接 IP 监听。ID/中继端点设为本机回环，访问白名单为 `127.0.0.1`；通过 SSH 连接其 `127.0.0.1:21118`，使用正常 RustDesk 主窗口的一次性密码完成登录，没有修改永久密码。

真实会话已显示 Windows 桌面；鼠标点击、快捷键、字母/空格/数字输入、窗口最大化、全屏及退出、主动断开和重新连接均通过。默认解码偏好下曾出现记事本块状残影；优先软件 VP9 解码后，同一窗口、文字输入和最大化画面完整。该结果仅覆盖本轮 Chromium 主机，不代表所有 GPU、驱动和长期会话已通过。

SSH 通道打开确认不能证明 RustDesk 正在监听，客户端只有在 RustDesk 批准登录并解码出画面后才显示相应状态。设备身份、截图和现场日志仅存于工作区私有记录。

随后在 GMSSH 2.0.4 的实际机器列表激活临时脚本，由正常 RustDesk 连接弹窗批准会话，收到真实画面。桌面按钮关闭后可重新打开；放大画面、恢复面板后画面完整，监控卡片继续刷新。曾发现系统全屏返回后窗口裁切，因此内嵌模式改用页内放大。已有终端与 SFTP 的协议回归通过，本轮没有重新操作其他机器的用户终端。

自动逐键和快速批量输入曾出现乱序或漏字，来源尚未定位。随后操作者复核并反馈手动英文输入顺序正确，该反馈不代表所有输入模式都已验收。上述记录对应 0.4.0a3。

2026-10-13，按操作者指示改用另一台 Windows 试验机。macOS 启动器自动打开内嵌入口，经 Tailscale 验证目标并收到 RustDesk 密码挑战；操作者批准首次连接后收到真实画面。随后将同一已认证 iframe 升级为顶部标签，去掉第二行标题栏，实际在首页和 Windows 标签间切换，画面计数继续增长。模拟页面另行验证关闭标签会销毁查看器，重新打开才产生新加载。

日常版本安装到不参与 iCloud 同步的本机目录后，操作者输入现有 RustDesk 密码并勾选记住，实际登录成功、页面确认保存到钥匙串。正常退出并重新启动后，无需再输入密码或远端批准即收到真实桌面，画面计数达到 38 帧以上。这是应用退出重开的验证，未测试整台 Mac 重启或钥匙串锁定状态；没有修改 Windows 固定密码。中文输入法、UAC 和长时间运行仍待验证。

## 依据与许可

- [Kessoku MIT Web 客户端及功能边界](https://github.com/q1ngyang/rustdesk-api-kessoku/tree/edfdd5b07f04bac6c3cdf96036fe9cb69164fb8d/web-client)
- [RustDesk 1.5.0 的直接 IP 连接路径](https://github.com/rustdesk/rustdesk/blob/1.5.0/src/client.rs)
- [RustDesk 原生 TCP 分帧](https://github.com/rustdesk/hbb_common/blob/master/src/bytes_codec.rs)
- [GMSSH 自定义网页窗口](https://doc-dev.gmssh.com/web_sdk/api.html#打开自定义窗口)
- [GMSSH 纯前端应用无需 init](https://doc-dev.gmssh.com/web_sdk/sdk_init.html)
- [Tailscale macOS 脚本的 CLI 模式](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)
- [RustDesk 固定密码与配置 CLI](https://github.com/rustdesk/rustdesk/blob/1.5.0/src/core_main.rs)
- [RustDesk 认证、直连和白名单选项](https://rustdesk.com/docs/en/self-host/client-configuration/advanced-settings/)

官方公共 `rustdesk.com/web` 设置了 `SAMEORIGIN`，官方自托管 Web V2 有 Pro 套餐门槛；这也是选择独立 MIT 客户端的原因，见 [官方说明](https://rustdesk.com/blog/rustdesk-web-client-v2-preview/)。本项目 MIT 许可证仅覆盖本项目代码；上述第三方源码和依赖按各自许可分发。Python wheel 不含 Windows 引擎；离线 Windows 安装器包含原始引擎文件，保留 [RustDesk 1.5.0 AGPL 许可](https://github.com/rustdesk/rustdesk/blob/1.5.0/LICENCE) 及对应源码来源。
