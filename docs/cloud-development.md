# Codex 云端开发交接

## 代码入口

仓库：`xinxinzai98/gmssh-windows-bridge`；云端开发入口为默认分支 `main`。`0.4.0a38` 的开发改动及云端脚本已从 `feature/free-rustdesk-desktop` 整合到主分支，新任务从 `main` 建立工作分支。版本保持 `0.4.0a38`，本次是源码和开发流程交接，没有创建新的安装包或 Release。

已纳入单 App 构建：从使用者已安装的原版导入未修改资源，增强端运行时使用包内 `vendor.asar`。首页已移除极目账号登录、账号云同步、顶部版本提示和独立工作区按钮；设置移到左下角，文件中心按钮颜色已修正。设备认证、终端、桌面和文件功能继续保留。

## 准备环境

按[官方 Codex Cloud 环境指南](https://learn.chatgpt.com/docs/environments/cloud-environments)在设置中创建或选择仓库环境，准备后发布环境供后续任务使用。把下面的安装命令作为环境的 Install script；仓库中的脚本不会自行配置账号侧环境。当前云端不支持 Computer use 和浏览器操作，原生界面验收继续在本地进行。

建议 Python 3.12+、Node.js 22.12+ 和 npm。PATH 中需有支持工具链自动选择的 Go（1.21+）；脚本通过 `GOTOOLCHAIN=go1.27.2` 使用与仓库工作流相同的工具链，缺少时由 Go 官方机制获取。安装阶段需要访问 Python/npm 软件源及 Go 工具链源；开发不需要真实设备地址、密码、OpenAI API key 或远程服务 token。

```bash
bash tools/cloud_setup.sh
```

安装会建立 `.venv`、安装 `.[desktop,ai]` 和 `desktop-web/package-lock.json` 锁定的前端依赖。已有环境可用 `GMSSH_SETUP_PYTHON` 指定 Python 可执行文件；依赖不变时复用准备好的环境。

检查命令：

```bash
bash tools/cloud_check.sh quick
bash tools/cloud_check.sh full
```

`quick` 覆盖启动器打包、源码净化、启动/更新拦截、Windows sudo 分流与工作区回归。`full` 增加全量 Python、TypeScript/Vite 构建、串行 Node、Go 解包/接入组件和回环 HTTPS 的 Python/Go AI 联调。可用 `GMSSH_TEST_PYTHON` 指定已有测试解释器。前端构建会重建生成资源，提交前检查生成资源与源码是否同步。

测试使用合成设备、临时文件和回环接口；大文件测试也会在临时目录创建合成数据。Windows PowerShell、DPAPI、真实挂载目录等平台项目在条件不满足时跳过；不要用跳过后的通过结果替代 Windows 或 Mac 实机验收。云端环境还需实际执行这些命令，本轮本机检查不能证明云端已经运行成功。

## 后续边界与待办

- 真实连接配置、密码、钥匙串、证书、主机密钥、现场截图和运行目录保留在本地，不上传到仓库或云端环境。
- 普通开发只改源码、构建和合成检查；不复制完整 App，不安装 Windows 包，不连接或操作任何现用设备。本地仍保留原版作为回退，云端任务不能清理它。
- 用户要求的“两行合成一行”尚未定位，先前提出的三种位置都被否定；须有明确截图后再改布局。
- Mac 原生菜单仍有原版名称。`CFBundleName` 参与 Electron helper 定位，应先分析并补回归，不能只改字符串。打开增强端不代表所有原版基座版本均已兼容。
- 保留自动更新覆盖保护和认证/权限边界。完整 `.app` 包含原版资源，公开交付仍只提供自有源码与构建工具，不能把当前安装结果直接作为通用下载包。

可直接用于下一次云端任务的交接提示：

> 从 `main` 建立工作分支，继续 GMSSH 增强扩展开发。先读 `AGENTS.md`、`CONTRIBUTING.md`、`docs/cloud-development.md` 和相关验证记录，运行 `bash tools/cloud_check.sh quick` 建立基线。只做源码、构建和合成回归，保持一个增强 App 的架构，不引入本机配置或凭据，不连接真实设备、不部署。先检查 Mac 菜单旧名称与 Electron helper 的关系，给出可验证的最小修复；“两行合一行”尚未定位，暂不改动。提交前运行相关检查及 `full`，区分通过、平台跳过与待实机验收，更新必要说明并提交 PR，不直接改 `main`。
