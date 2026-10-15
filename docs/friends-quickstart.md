# 给朋友的安装说明

这是局域网友测版。Windows 电脑安装被控端；Mac 安装增强控制端。两台电脑需要能在同一局域网互访，不要求安装 Tailscale。

## Windows 电脑

1. 从本项目的 GitHub Release 下载 `GMSSH-Windows-Setup-版本号.exe`，运行并完成正常管理员提示。
2. 阅读安装说明，亲自设置 GMSSH 连接密码。安装会新建专用本地管理员账号 `gmssh`，安装后台桌面引擎和托盘，并允许同一子网访问 SSH 22 端口；原 Windows 账号密码保留。若已有冲突账号、SSH 或桌面服务，会停止并提示检查。
3. 将桌面生成的 `GMSSH-connection.json` 交给控制端使用者。该文件不含连接密码，但包含设备地址和身份，只交给需要连接这台电脑的人，不上传到公开仓库；通过可信渠道单独告知连接密码。

SSH 和桌面引擎包含在安装包中，无需从 Windows 可选功能下载 OpenSSH。仅缺少所需 VC++ 运行库时，安装器才联网从微软官方获取，核对固定 SHA-256 与签名后安装；下载失败可先从[微软官方页面](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)安装 x64 运行库后重试。

托盘中可查看状态、复制连接信息和修改连接密码。系统保护目录及其他账号的加密文件仍受 Windows 权限限制。

## Mac 控制端

1. 先安装原版 GMSSH **2.0.4** 到 `/Applications`。安装器会复用可用的 Python 3.12–3.14；没有时，从固定的 [python-build-standalone 官方发布](https://github.com/astral-sh/python-build-standalone/releases/tag/20261013)获取独立 Python 3.12，并校验 SHA-256。无需手工安装 Python，也不修改系统 Python；首次准备运行环境需要访问 GitHub 和 PyPI。
2. 下载并完整解压 `GMSSH-Mac-Setup-版本号.zip`，双击 `Install GMSSH.command`。它只安装本项目的独立运行环境，再使用本机已有的原版 GMSSH 生成 `~/Applications/GMSSH 局域网增强端.app`。
3. 正常退出其他 GMSSH 实例，打开新入口，并按 macOS 提示允许局域网访问。首页点击“接入 Windows”，导入连接文件，核对电脑名、地址与 Windows 端的 SSH 指纹，再输入连接密码。

原版 2.0.4 官方下载：[Apple Silicon](https://gmb-prod-gw.oss-accelerate.aliyuncs.com/client/mac/arm64/2.0.4/GMSSH-mac-2.0.4-arm64-pro.dmg)、[Intel](https://gmb-prod-gw.oss-accelerate.aliyuncs.com/client/mac/x64/2.0.4/GMSSH-mac-2.0.4-x64-pro.dmg)。2026-10-15 已核对两种架构的官方更新清单和下载响应；Intel 增强端仍待实机验收。已有其他版本时先保留，安装器会停下提示，不自动覆盖或降级。

首次接入会建立监控卡片与桌面入口。新版连接文件声明共用密码时，桌面首次认证复用本次输入；勾选记住后，通过认证才保存到这台 Mac 的钥匙串。同一身份重复导入会打开已有设备。

Mac 包不包含原版 GMSSH 的完整程序，不携带发布者的设备列表、钥匙串、登录状态或预览应用。原版依赖与许可边界见[发布说明](https://github.com/xinxinzai98/gmssh-windows-bridge/blob/v0.4.0a8/docs/releasing.md)。

## 遇到问题

- 浏览器或系统的安全提示由使用者亲自处理；遇到不理解的提示先停下核对。
- 无法连接时先检查局域网地址、Windows 托盘自检，以及 Mac 的局域网授权。Windows PIN 不是 GMSSH 连接密码。
- 已有同名 GMSSH 账号或 SSH 服务时，先确认用途；安装器不会自动覆盖它们。已有安装重跑会保留密码并执行自检，不能当作完整升级器使用。
- 反馈可提供版本、系统版本与错误文字。不要公开上传连接密码、钥匙串、GMSSH 数据库、私钥、完整日志或含真实设备的截图。

目前已验证 Apple Silicon Mac 与 Windows 11 测试环境，以及 Linux 首页的原生摘要详情。全新电脑上 OpenSSH MSI 首装、重启恢复、改密后重连和硬件唤醒仍需继续实机验收；Intel Mac 未完成实机验收。请先用于可接管的测试电脑。
