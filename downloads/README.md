# 0.4.0a39 Mac 更新包（Alpha）

[下载 Mac 安装／更新 ZIP](GMSSH-Mac-Setup-0.4.0a39.zip?raw=true) · [Python wheel](gmssh_windows_bridge-0.4.0a39-py3-none-any.whl?raw=true) · [公开源码包](GMSSH-Source-0.4.0a39.zip?raw=true) · [使用说明](README.txt) · [校验清单](SHA256SUMS?raw=true)

现有 0.4.0a38 增强端：先从应用菜单正常退出，完整解压 ZIP，双击 **Update GMSSH.command**。更新器复用现有独立运行环境，保留配置、密码、包内原版资源及主程序 UUID；保存旧组件并在失败时恢复。首次安装使用 Install GMSSH.command，需已有受支持的 GMSSH 2.0.4 基座。

本版包含单行远程桌面工具栏。对应源码提交：[`e956040`](https://github.com/xinxinzai98/gmssh-windows-bridge/tree/e956040533be641c3d405cebbe92b4e555b017b9)。本轮没有新 Windows 安装器，也不自动启动或连接设备。

新更新器有合成事务和回退测试，Mac 原生安装尚未验收，保持 Alpha。GitHub Actions 因账户计费问题未启动，工作区检查不代表 GitHub CI 通过。本分支保存已逐项校验的发行文件；发行状态及固定版本下载链接以 [v0.4.0a39 Release](https://github.com/xinxinzai98/gmssh-windows-bridge/releases/tag/v0.4.0a39) 为准。

ZIP SHA-256：`5022768d32ab9f2c3ac36d520981323f4fcec0304dfda5098fc1919a16972666`。
