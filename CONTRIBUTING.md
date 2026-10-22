# 贡献指南

欢迎提交可复现的问题、兼容性记录和聚焦的改进。首次使用请先阅读[安装指南](docs/getting-started.md)。

## 开发环境

核心桥需要 Python 3.10+。前端构建还需要 Node.js 和 npm；Mac 启动器依赖本机已安装的 GMSSH 2.0.4。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[desktop]'
```

Windows 激活虚拟环境时使用 `.venv\Scripts\Activate.ps1`。macOS 发布安装器使用独立 Python 3.12–3.14 环境，其依赖版本见 `install/macos/requirements-macos.txt`。

Codex 云端的仓库环境、安装脚本、快速/完整检查命令和当前待办见[云端开发交接](docs/cloud-development.md)。云端只带源码和合成夹具，实际设备与本地凭据不随仓库转移。

## 轻量开发流程

日常改动先在源码中验证，不默认复制完整 `.app`、安装新预览版或连接真实设备。复用已有开发环境；依赖未变时不重复安装，按改动范围执行检查，打包和实机验收放到最后。

首页和添加机器界面可先使用现有合成页面。从项目根目录启动仅本机可访问的静态预览：

```bash
python -m http.server 8020 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8020/tests/desktop-entry.html` 或 `http://127.0.0.1:8020/tests/pairing-entry.html`，使用页面中的预览或检查入口。两页使用模拟设备与接口，不需要真实账号或桌面连接。结束后停止该服务；这类预览不替代原生客户端和设备验收。

需要集成验收时，沿用一个固定的增强客户端入口和配置，不按日期或版本新增常驻应用、运行环境及验收实例。更新前正常退出旧进程，保留配置、钥匙串和可恢复备份；不能用首装脚本强行覆盖现有客户端。新构建从已安装原版导入未修改的资源到同一个增强 App，运行时使用包内资源；首次构建仍需要原版。原版文件只在整合版验证完成、确认恢复方式后另按清单归档，不能通过卸载器删除关联配置。普通开发不同时启动两套客户端，也不在未使用时持续连接远端桌面。

旧应用、副本和运行环境的整理单独盘点：先确认正在使用的入口、关联配置、清理数量与大小、原路径映射和恢复方式，再按获准清单移入独立废纸篓目录。不要为结束一次开发直接删除凭据、设备配置或当前运行状态，也不要把副本仍在磁盘上等同于它们都在运行。

## 本地验证

```bash
python -m unittest discover -s tests -v
python tools/build_share_bundle.py --check-only
```

前端修改还需执行：

```bash
cd desktop-web
npm ci --ignore-scripts
npm run build
cd ..
node --experimental-vm-modules --test --test-concurrency=1 tests/*.cjs
```

原生流式传输回归还需要当前 Python 环境安装 `.[desktop]`；可用 `GMSSH_TEST_PYTHON` 指定该解释器。测试只在临时目录建立合成文件和回环服务，Mac/Unix 控制端的文件描述符回归在 Windows 跳过。

可用 `GMSSH_TEST_VOLUME_DIR` 指向专用测试挂载目录来执行真实磁盘路径检查；测试仅在该目录中新建并清理自己的随机子目录，不删除共享目录。该变量未设置时，真实挂载检查跳过，模拟检查仍运行。`tests/native_file_fixture.js` 可通过 `GMSSH_TEST_FORCE_COPY=1` 查看兼容保存阶段；该开关只存在于测试夹具中。

前端构建会更新 `gmssh_windows_bridge/desktop_web/`；相关源码与生成资源需要一同提交。页面交互修改可使用 `tests/desktop-entry.html` 与 `tests/pairing-entry.html` 中的合成设备检查，记录实际执行结果。

Windows PowerShell 专属测试需要在 Windows 执行，在其他系统上会跳过。Go 安装器解包检查可在 `tools/windows_installer/` 中运行 `go test extract.go extract_test.go`；连接码组件在 `tools/windows_connect/` 中运行 `GO111MODULE=off go test`。Windows 平台还会检查真实 DPAPI 往返和当前账号 SID，只写临时目录，不创建账号或修改服务。自动化检查不替代真实设备验收；当前已完成和未完成的范围见[验证记录](docs/validation.md)。

## 提交改动

1. 说明要解决的问题、触发条件和改动后的行为，保持单次提交或 PR 的范围清晰。
2. 运行与改动相关的检查，分别列出通过、跳过和未执行的项目；涉及远控、文件或电源时注明是否做了实机操作。
3. 不提交真实设备地址、连接文件、密码、会话令牌、私钥、数据库、现场日志、应用副本或运行环境。截图使用合成设备或移除资产信息。
4. 改变安装、认证、权限、文件写入或服务行为时，说明影响与恢复方式。第三方组件需要保留版本、来源和许可。

发布构建和附件检查见[发布说明](docs/releasing.md)。安全问题请按[安全说明](SECURITY.md)处理，不在公开 Issue 中披露凭据或可直接利用的细节。
