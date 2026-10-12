# 验证记录

2026-10-11，v0.1.0 发布候选代码：

- 主机：Apple Silicon macOS、Python 3.14；目标：Windows 11 25H2，现有 OpenSSH Server。
- 原型在 GMSSH 2.0.4 的机器卡片上验证了 CPU、内存、固定卷容量与动态刷新。
- 整理后的包使用同一真实 Windows 主机，通过独立监听端口完成 `tools/smoke.py` 验收：SSH 认证、快慢采集、数值范围、磁盘字节换算、任意命令拒绝均通过。
- 单元测试使用合成指标和模拟对端，不应与上述实机验证混淆。
- Windows 默认 SSH Shell 可能受 8191 字符命令长度限制；发送前移除固定脚本的注释和空行，并保留长度上限检查。标准输入传送在实测环境出现阻塞，未采用该路径。
- 不包含目标 IP、账号、密码、主机密钥、截图或现场日志。

尚未验证：macOS Intel、Linux/Windows 上运行桥、非管理员账号的所有权限组合、超过 64 逻辑处理器、所有 GMSSH 历史/未来版本、长期后台运行。

## 0.2.0 本地候选版本

2026-10-12，接续前一轮终端与 SFTP 开发：

- 本轮环境：Apple Silicon macOS、Python 3.14.6、Paramiko 5.0.0；wheel 使用已有 Python 3.12.14 / setuptools 84.0.0 离线构建。
- 源码和安装后的 wheel 分别通过 15 项自动测试，涵盖默认认证/拒绝边界、指标采集、终端输入输出、退出码、窗口缩放、二进制/中文文件名 SFTP，以及终端和监控并发。
- 两个新增回归用例先在旧转发器上复现了退出码后输出丢失，以及输出 EOF 未传递造成的等待；修复后通过。断开连接收尾不再因已关闭通道抛出未处理异常。
- wheel 包含 `collector.ps1`、`login.ps1` 和 `relay.py`。安装后逐文件核对内容，并在源码目录之外用隔离 Python 执行 `--help`、`--version` 和上述 15 项协议测试，确认导入的是安装包。
- 前一轮开发记录曾报告 Windows 原生命令、交互终端、SFTP 中文文件名/二进制传输/重命名实测通过。本轮没有重新连接真实 Windows 或复测 GMSSH 页面；自动测试使用模拟 SSH/SFTP 对端。
- 根据前一轮 GMSSH 2.0.4 验收记录，页面终端仍强制要求 Linux sudo。桥不假报 sudo/root，也未完成页面文件管理、Linux Agent、桌面应用或服务管理兼容。

本轮成果为本地候选包，未执行 GitHub 推送、远端 CI、tag 或 Release。

## 0.2.1 GMSSH 页面终端

2026-10-12，GMSSH 2.0.4 + Apple Silicon macOS + Windows 11 实机验收：

- 复现了页面“仅终端”入口因 Linux sudo 探测失败而退出；兼容应答通过后，另发现固定 Bash 启动请求在 Windows 上失败并触发重连。
- `--gmssh-terminal` 为探测返回明确的协议兼容标志，并将已捕获启动请求按指纹匹配为原生 SSH shell；不执行 Linux profile 修改、不安装 sudo、不修改 Windows 账号或权限。
- 已从真实 GMSSH 页面进入 Windows CMD，并成功执行 `whoami`、`hostname` 及 PowerShell 的 `Win32_OperatingSystem.Caption` 查询，屏幕返回真实 Windows 用户、主机名和 Windows 11 系统名称。
- 新增模拟协议检查覆盖开关启用/关闭、原生 shell 启动、真实用户名查询和拒绝错误启动指纹。源码通过 18 项自动测试；测试中的启动指纹是合成数据，与上述真实页面验收分开记录。
- Linux Agent、桌面应用、服务管理、GMSSH 页面文件管理及其他客户端版本未验收。未执行 Windows 提权或账户修改，未创建 tag/Release；本节记录本地验收。

## 0.3.0 本地候选版本

2026-10-12，默认 PowerShell 与本地后台运行：

- 在 GMSSH 2.0.4 的真实页面中进入 Windows PowerShell 5.1；`$PSVersionTable.PSVersion.ToString()`、`whoami`、`Get-Location` 和系统名称查询均成功回显，中文正常显示。
- 后台启动器返回 PID 并退出后，本地桥继续监听；启动就绪和占用端口失败路径均有独立进程测试。源码通过 21 项自动测试。
- 工作目录只在 PowerShell 提示符中呈现。尝试直接发送原来的控制字符目录标记时，Windows ConPTY 过滤了控制字符，因此已去除此路径，未声称完成 GMSSH 目录联动。
- `--shell` 不修改目标 OpenSSH 默认 Shell、注册表或 profile。后台模式不保存密码、不设置开机自启动；本轮后台运行只在 macOS 验收。
- 页面文件管理仍需完整桌面目录、回收站和权限等接口适配，本轮未完成。本节记录 0.3.0 的本地验收；源代码推送与 tag/Release 分开进行。

## 0.4.0a3 免费桌面实机预览

2026-10-12，Apple Silicon macOS、Python 3.12、现代 Chromium 与授权 Windows 11 试验机：

- 官方 RustDesk 1.5.0 安装文件通过哈希及 Windows Authenticode 检查；回读程序版本为 1.5.0+68，服务运行、用户会话进程与直接访问监听存在。访问白名单为本机回环，经既有 SSH 校验主机密钥并转发。
- 使用 RustDesk 正常主窗口显示的一次性密码完成实际登录，收到真实 Windows 桌面。没有读取受保护 IPC 的临时密码、修改永久密码或扩大远程主机白名单。
- 远程鼠标、开始菜单快捷键、应用搜索和 31 字符测试句输入通过，测试句包含字母、空格和数字。窗口最大化、全屏退出、主动断开及新一次性密码重新连接通过。
- 默认 VP9 解码偏好出现块状残影；改为 `prefer-software` 后，同一记事本的文字与窗口变化完整显示。本轮覆盖该 Chromium 主机，其他 GPU/驱动及长期运行仍待验证。
- 操作者完成控制台粘贴安全提示后，使用标准浏览器脚本加载方式接通 GMSSH 2.0.4 的实际 iframe。原先使用 `require` 的激活命令不适用于该页面，已替换并由桌面服务提供通用脚本。
- `desktop-web/public/gmssh-entry.js` 只挂接指定机器的桌面按钮，可移除、重载后失效。真实画面、基本输入、桌面按钮关闭重开，以及内嵌画面的放大/恢复通过；关闭面板后监控卡片继续刷新。
- 实测系统全屏返回后出现窗口裁切；内嵌模式改用页内放大，恢复后显示完整。独立浏览器继续提供全屏。留空 RustDesk 密码的人工确认等待为 5 分钟，状态区明确区分 SSH 接通、登录请求已发送及实际画面。
- 自动逐键和快速批量输入出现过乱序或漏字，来源尚未定位，快速连续输入仍待验收。没有修改签名客户端或安装 Linux Agent，也未重新操作其他机器的用户终端。
- 本机实机证据与设备身份仅存私有工作目录。浏览器协议模拟测试、真实 Windows 会话与 GMSSH 接入分开记录；没有创建 tag/Release 或宣布稳定版本。
- TypeScript 检查及 Vite 构建通过；源码与安装后的 wheel 在独立目录分别通过 25 项自动检查。wheel 中的当前 JavaScript、CSS、HTML 及两份许可与源码静态目录一致，旧构建残留的 JavaScript 已排除。
