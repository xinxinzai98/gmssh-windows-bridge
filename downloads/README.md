# 0.4.0a39 Mac 更新包（Alpha）

[下载 Mac 安装／更新 ZIP](GMSSH-Mac-Setup-0.4.0a39.zip?raw=true) · [校验清单](SHA256SUMS?raw=true)

现有 0.4.0a38 增强端：先从应用菜单正常退出，完整解压 ZIP，双击 **Update GMSSH.command**。更新器复用现有独立运行环境，保留配置、密码、包内原版资源及主程序 UUID；保存旧组件并在失败时恢复。首次安装使用 Install GMSSH.command，需已有受支持的 GMSSH 2.0.4 基座。

本版包含单行远程桌面工具栏。对应源码提交：[`e956040`](https://github.com/xinxinzai98/gmssh-windows-bridge/tree/e956040533be641c3d405cebbe92b4e555b017b9)。本轮没有新 Windows 安装器，也不自动启动或连接设备。

新更新器有合成事务和回退测试，Mac 原生安装尚未验收，保持 Alpha。GitHub Release 上传接口当前不可用，Actions 因账户计费问题未启动；本分支提供同一份已校验的下载文件，不把它标记为已发布 Release。

ZIP SHA-256：`5022768d32ab9f2c3ac36d520981323f4fcec0304dfda5098fc1919a16972666`。
