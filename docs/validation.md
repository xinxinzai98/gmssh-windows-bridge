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
