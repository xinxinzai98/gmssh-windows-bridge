# 发布检查

## 两端交付

GitHub 应同时提供 Windows 服务端和 Mac 增强控制端。只发 Windows 安装包，原版 GMSSH 用户无法获得新增的首页、桌面标签和文件工具栏。

| 对象 | 交付方式 | 依赖与当前状态 |
|---|---|---|
| Windows 服务端 | `GMSSH-Windows-Setup.exe` 与本项目源码 | 离线 OpenSSH、内部桌面引擎、GMSSH 托盘和密码窗口；新电脑完整安装仍待验收 |
| Mac 增强端 | `gmssh-windows-bridge` wheel、前端源码、本地启动器构建工具 | 依赖用户安装的原版 GMSSH 2.0.4；当前按目标设备构建，尚无通用多设备安装向导 |
| 私有验收包 | 按指定设备生成的启动器或账号工具 | 包含本机路径或设备配置，仅供相应设备使用，不作为通用 Release 附件 |

Mac 构建器从已安装 GMSSH 复制运行框架，并以只读方式引用原版 `app.asar`，在独立启动器中加载本项目的页面适配。**生成的完整 `.app` 仍包含原版运行组件，不能因为包装代码是 MIT 就视为可以公开再分发。** 应先发布自己的源码和构建/安装工具；公开完整应用前核对原版许可或取得明确授权。此次核对官方仓库的 license 元数据及本机 2.0.4 包元数据，没有据此建立完整应用再分发许可。

增强启动器保留官方版本查询，将官方新版本提醒显示为顶部“待兼容验证”提示；拦截官方包下载、安装请求及 macOS 原生安装器，避免官方 `.app` 替换增强入口。原版 GMSSH 本身不受影响。2026-10-14 官方动态接口和对应安装清单确认 2.0.5 可用，发布于 2026-10-13；增强端当前仍按已验收的 2.0.4 构建。升级基座需先在隔离目录重新验收本机桥、sudo 分流、终端启动指纹、原生卡片和桌面标签，再发布配套增强包。

Mac 开发预览使用本地 ad-hoc 签名。更新后须在真实应用中验收局域网连接：终端直连成功不能代替应用授权检查，后台子进程也归属启动它的 App。Apple 建议使用其签发的代码签名身份来可靠跟踪应用，并记录了多个版本并存时的权限显示问题；详见 [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。保留有效的唯一主程序 UUID，不修改系统隐私数据库，也不通过更换启动主体代替正常授权。

预览构建与应用安装分开处理；同一标识的旧预览版不应一直保持系统注册。2026-10-14 的一次更新在权限已允许时出现应用内 errno 65，按明确授权撤销 5 个旧预览版注册、刷新当前版后恢复，并完成真实界面文件往返验收。回退文件仍可保留；重新打开旧副本会再次注册它，不能把清理注册当作一次性的永久修复。

Windows 内部引擎保留 RustDesk 1.5.0 的原始二进制，不声称自己实现或获得 RustDesk 全部能力。公开捆绑版本时，应提供实际使用版本的开源源码获取方式、许可与版权通知，并核对 OpenSSH、微软 VC++ 运行库等再分发要求。本项目自己的 MIT 许可不替代第三方许可。当前候选包尚未作为公开 Release 发布。

## 本地验收与公开发布

1. 确认只发布当前独立目录，**不要把它的父目录设备维护推到 GitHub**。
2. 运行单元测试和构建；检查 wheel 包含 `collector.ps1`、`login.ps1`、`powershell.ps1`、`relay.py` 和 `background.py`。0.4 还须包含 `desktop.py`、当前 Web 静态资源及第三方许可。使用干净构建目录，核对 wheel 的哈希资源与当前静态目录一致，避免 `build/lib` 留下旧 JavaScript。安装 wheel 后在独立目录执行 CLI，避免从源码目录导入而掩盖缺失文件。
3. 检查 `git status` 和待提交文件：不得包含账号密码、内网/公网真实资产地址、host_key、known_hosts、现场日志、虚拟环境、GMSSH 二进制或提取材料。
4. README 中区分实机验证与模拟测试。兼容客户端版本变化需要重新实测，不凭测试用假数据宣称兼容。
5. 创建仓库时使用名称 `gmssh-windows-bridge` 或自行选择；添加 MIT 许可证及非官方说明。不要声称获得 GMSSH 官方支持。
6. 开启 GitHub 私密漏洞报告功能，填写维护者信息。0.3 仍是实验版本；发布说明必须说明 sudo 标志是终端协议适配、仅验证 GMSSH 2.0.4，以及 SFTP 写权限范围。后台运行不等于开机自启动。

本地验证与构建：

```bash
python -m unittest discover -s tests -v
python -m pip wheel . --no-deps --wheel-dir dist
python -m pip install --force-reinstall --no-deps dist/gmssh_windows_bridge-0.4.0a5-py3-none-any.whl
python -I -m gmssh_windows_bridge --help
python -I -m gmssh_windows_bridge --version
```

本项目代码许可证为 MIT。构建、检查和本地文件交付与 GitHub 推送、创建 tag/Release 分开进行；远端 CI 的结果须从实际运行记录确认。
