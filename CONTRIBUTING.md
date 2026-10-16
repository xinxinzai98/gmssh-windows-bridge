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
node --experimental-vm-modules --test tests/*.cjs
```

原生流式传输回归还需要当前 Python 环境安装 `.[desktop]`；可用 `GMSSH_TEST_PYTHON` 指定该解释器。测试只在临时目录建立合成文件和回环服务，Mac/Unix 控制端的文件描述符回归在 Windows 跳过。

前端构建会更新 `gmssh_windows_bridge/desktop_web/`；相关源码与生成资源需要一同提交。页面交互修改可使用 `tests/desktop-entry.html` 与 `tests/pairing-entry.html` 中的合成设备检查，记录实际执行结果。

Windows PowerShell 专属测试需要在 Windows 执行，在其他系统上会跳过。Go 安装器解包检查可在 `tools/windows_installer/` 中运行 `go test extract.go extract_test.go`；连接码组件在 `tools/windows_connect/` 中运行 `GO111MODULE=off go test`。Windows 平台还会检查真实 DPAPI 往返和当前账号 SID，只写临时目录，不创建账号或修改服务。自动化检查不替代真实设备验收；当前已完成和未完成的范围见[验证记录](docs/validation.md)。

## 提交改动

1. 说明要解决的问题、触发条件和改动后的行为，保持单次提交或 PR 的范围清晰。
2. 运行与改动相关的检查，分别列出通过、跳过和未执行的项目；涉及远控、文件或电源时注明是否做了实机操作。
3. 不提交真实设备地址、连接文件、密码、会话令牌、私钥、数据库、现场日志、应用副本或运行环境。截图使用合成设备或移除资产信息。
4. 改变安装、认证、权限、文件写入或服务行为时，说明影响与恢复方式。第三方组件需要保留版本、来源和许可。

发布构建和附件检查见[发布说明](docs/releasing.md)。安全问题请按[安全说明](SECURITY.md)处理，不在公开 Issue 中披露凭据或可直接利用的细节。
