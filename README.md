# GMSSH Windows Bridge

**将 Windows 的监控、PowerShell、文件访问和远程桌面接入 GMSSH / 极目Linux桌面。**

非官方、实验性兼容项目。基础桥默认只读监控，可显式启用 Windows 原生终端和 SFTP 转发。可选 Mac 增强启动器增加统一设备列表和桌面工作区；它使用本机已安装的 GMSSH 2.0.4，保留原版应用文件。

项目交付分为 **Windows 一体化服务端** 和 **Mac 增强控制端**。Windows 用户安装一个程序，使用 GMSSH 自己的托盘、状态窗口和密码设置；Mac 端提供增强源码与本机构建工具。当前 Mac 启动器按设备配置构建，通用多设备安装向导仍待开发。GitHub 交付范围、原版依赖和许可说明见 [发布说明](docs/releasing.md)。

```text
GMSSH 机器卡片
    │ SSH → 127.0.0.1:22229
    ▼
本机 Python 兼容桥
    │ SSH，校验 Windows 主机密钥
    ▼
Windows OpenSSH Server → 固定 PowerShell / CIM 采集脚本
```

## 能做什么

| 功能 | 状态 |
|---|---|
| CPU 逻辑处理器数、使用率 | 支持真实采集 |
| 内存总量、使用量、使用率 | 支持真实采集 |
| 本地固定磁盘容量、已用空间 | 支持真实采集 |
| 系统名称、运行时间、进程数量 | 提供相应字段 |
| Windows 原生 SSH 终端、命令执行 | `--enable-terminal` 显式启用 |
| 指定 CMD / PowerShell | `--shell cmd` / `--shell powershell`，默认沿用 OpenSSH 设置 |
| Windows 原生 SFTP 文件访问 | `--enable-sftp` 显式启用，权限由 Windows 账号决定 |
| GMSSH 2.0.4 页面中的终端入口 | `--gmssh-terminal`，已在 Windows 11 实机验证 |
| GMSSH 桌面应用、sudo、Linux 服务管理 | 不支持 |
| 本地后台运行 | `--background`；输出 PID 和日志路径 |
| 免费 RustDesk Web 查看器 | 0.4.0a5 实验功能；监控与桌面复用已认证的 SSH 连接 |
| 统一首页、顶部桌面标签、文件侧栏 | 列表/卡片切换、独立滚动及分页、状态灯、配置悬浮提示、IP 复制和原生右键编辑 |
| 设备详情 | CPU/内存/磁盘，Windows 网卡链路、流量、配置与运行时间；信息经现有 SSH 只读采集 |
| Linux 文件互传入口 | 打开对应 GMSSH 原生桌面并调用内置文件管理器，不新增一套 Linux 传输协议 |
| 桌面工具栏 | 键盘、文本剪贴板、屏幕切换与画质控制已实现；新增功能待目标机复核 |
| 文件上传与下载 | 经已认证 SSH/SFTP；单文件上限 512 MiB，不覆盖已有目标文件 |
| 电源操作 | 锁屏、重启、关机；重启/关机在控制端倒计时 30 秒后发送，实机操作未执行 |
| 局域网唤醒 | 配置已配对网卡 MAC 和实际子网广播地址后可用；依赖目标硬件支持 |
| Windows 端安装器候选 | 离线 SSH、内部桌面引擎、开机服务、GMSSH 托盘与密码窗口；待 Windows 全流程验收 |
| 多台 Windows | 每台运行一个实例，使用不同本地端口 |

首个原型已在 **Apple Silicon macOS + Windows 11 25H2 + GMSSH 2.0.4**上验证机器卡片的动态 CPU、内存和磁盘显示。此结果不代表所有客户端版本都兼容，也不代表本项目获得官方支持。兼容依据见 [协议说明](docs/protocol.md)。

## 环境要求

- 运行桥的电脑：Python 3.10+，可访问目标 Windows 的 SSH 端口。
- 目标 Windows：OpenSSH Server 已配置，现有账号允许密码登录，可运行 Windows PowerShell 5.1、CIM 和 `Add-Type`；文件访问还需原生 SFTP 子系统可用。
- 网络：局域网 IP 或可解析主机名。本项目不安装或配置 VPN；其他网络方式由使用者自行管理。桥进程不改远端设置，Windows 首次接入向导在明确运行后配置 SSH 和局域网防火墙规则。
- 只支持密码认证。桥将 GMSSH 输入的账号密码用于目标认证，**不落盘**；GMSSH 自身保存凭据的行为另计。

## 快速开始

新 Windows 电脑的[局域网端安装器候选](docs/windows-first-run.md)提供单个 `GMSSH-Windows-Setup.exe`，内含官方离线 OpenSSH MSI 和校验后的桌面引擎。使用 GMSSH 自己的托盘和密码窗口，设置开机服务；默认仅允许本地子网访问 SSH。已有桌面的测试机可使用 `-MonitorOnly`，保留原密码和配置。Windows 全流程验收状态单独记录。

在项目目录中执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
```

如果运行桥的电脑也是 Windows，激活命令为 `.venv\Scripts\Activate.ps1`。Windows 上运行桥的方式尚未实机验收。

先用正常 SSH 核验 Windows 主机身份，将可信主机密钥加入 `known_hosts`：

```bash
ssh windows-user@windows-host
```

第一次连接显示的指纹应通过可信渠道核对。桥默认拒绝未知或变化的目标主机密钥，不会自动接受。

然后启动桥，替换以下占位主机名和账号：

```bash
gmssh-windows-bridge \
  --target windows-host \
  --username windows-user \
  --listen-port 22229
```

需要自定义端口或已知主机文件时：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --target-port 22 --known-hosts ~/.ssh/known_hosts --listen-port 22229
```

在 GMSSH 添加机器：

| 字段 | 填写内容 |
|---|---|
| 名称 | 自定，例如 Windows 工作站（仅监控） |
| Host | `127.0.0.1` |
| 端口 | `22229` |
| 用户名 | 与 `--username` 相同的 Windows 账号 |
| 密码 | 该 Windows 账号的现有 SSH 密码 |
| 跳板机 | 不设置 |

测试连接后添加。0.4.0a5 增强启动器会为已配置的 Windows 兼容桥自动选择原生 `sudoPolicy: skip`，添加和编辑时无需输入 Linux sudo 密码。匹配要求本机桥地址、端口和 Windows 账号全部一致，其他机器保留原验证。单独使用原 GMSSH 客户端时，仍可在该提示选择 **跳过**；Windows 不存在对应的 sudo 密码。

保持桥进程运行，刷新机器列表。按 `Ctrl-C` 停止；停止后该试验条目会显示离线，原来的 Windows SSH 服务不受影响。

### 原生终端与 SFTP

0.2.0 增加两个独立开关，均默认关闭。需要这两项能力时启动：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --listen-port 22229 --enable-terminal --enable-sftp
```

在另一个终端中连接本地桥：

```bash
ssh -p 22229 windows-user@127.0.0.1
sftp -P 22229 windows-user@127.0.0.1
```

首次连接本地桥也需核对其主机密钥。可用 `ssh-keygen -lf ~/.gmssh-windows-bridge/host_key` 查看桥的指纹；自定义 `--host-key` 时使用对应路径。

终端使用 Windows OpenSSH 配置的默认 Shell，命令不会被改写为 PowerShell。输入、标准输出、错误输出、退出码和窗口尺寸变化直接转发；长时间运行的终端不会阻塞同一连接中的监控刷新。SFTP 保留 Windows 原生路径，支持账号权限内的读取、写入、重命名和删除；可用普通 SFTP 客户端或支持 SFTP 的文件管理器连接。

### GMSSH 页面中的 Windows 终端

0.2.1 增加独立的实验性页面兼容模式：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --listen-port 22229 --gmssh-terminal
```

在 GMSSH 添加或编辑对应条目，Host 填 `127.0.0.1`，端口与桥一致，账号密码仍使用原有 Windows SSH 账号；点击 **进入仅终端模式**。会话运行 Windows OpenSSH 配置的原生默认 Shell；默认配置通常是 CMD，也可在其中执行 PowerShell。

GMSSH 2.0.4 有两处 Linux 假设：登录必须通过 sudo 探测，交互终端必须执行固定 Bash 启动脚本。此模式对前置探测中的 `SUDO` / `SUDO_ACCESS` 返回兼容标志 `1`，对已实测启动请求按 SHA-256 精确识别并改为原生 SSH shell；`id -nu` / `id -un` 查询返回 Windows 实际用户名。客户端的 Linux profile 修改和 Bash 启动正文均不会执行。

**这些标志是协议适配，不代表 Windows 安装了 sudo、拥有 Linux root 或完成了 Windows 提权。** 密码认证、目标主机密钥验证和 Windows 账号权限保持原样。此开关自动启用原生终端；SFTP 仍需另加 `--enable-sftp`。未开启时保留 0.2.0 的行为。

已在 GMSSH 2.0.4 + Windows 11 验证页面中的 CMD、`whoami`、`hostname` 和 PowerShell 查询。其他版本的启动指纹可能变化，需重新验收。GMSSH 页面文件管理、Linux 桌面应用、Agent 和服务管理仍未兼容。

### 主机密钥与迁移

桥首次启动生成自己的 SSH 主机密钥，默认位置是 `~/.gmssh-windows-bridge/host_key`。保留它以免客户端提示主机身份变化；不要提交到 Git。可用 `--host-key PATH` 指定独立密钥。修改 `--target` 后应新建对应条目和密钥，避免同一入口悄悄指向另一台机器。

### 多台机器

分别启动多个进程，例如端口 `22229`、`22230`，各自指定目标、用户名和独立 `--host-key`。在 GMSSH 建立相应条目。当前版本不提供多实例统一管理。

### PowerShell 与后台运行（0.3）

直接在页面终端使用 PowerShell，并让本地桥在启动终端关闭后继续运行：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --gmssh-terminal --shell powershell --background
```

`--shell default` 沿用目标 OpenSSH 的默认 Shell；`cmd` / `powershell` 只影响该桥新开的交互会话，不修改目标注册表、SSH 服务设置或用户 profile。普通 exec 命令仍按原样转发。PowerShell 提供 UTF-8 输出，提示符显示真实工作目录；GMSSH 的目录联动和页面文件管理尚未适配。

后台启动会等待本地监听就绪再返回 PID；失败时返回非零退出码。默认日志在 `~/.gmssh-windows-bridge/bridge.log`，可用 `--background-log PATH` 指定；日志不保存密码、原始客户端命令或指标。启动器退出后进程继续运行，但电脑重启后不会自动恢复。

停止时使用启动器输出的当前 PID：macOS/Linux 执行 `kill PID`，Windows 执行 `Stop-Process -Id PID`。不要使用以前启动时的旧 PID。当前不提供自动重启、开机自启动或多实例管理器；后台运行在 macOS 实测，其他运行平台仍需验收。

## 必须知道的限制

0.4.0a5 的 macOS 启动器默认进入首页，点击设备原蓝色图标打开同一行的 Windows 桌面标签。局域网版本通过 SSH 同时提供监控、文件和桌面，桌面复用已认证的监控连接。此前真实桌面、标签切换和保存密码后退出重开已验收；本次界面、统一监控和首次安装流程的新增实机验收另见 [验证记录](docs/validation.md)。使用方法见 [免费 RustDesk 桌面接入](docs/desktop-rustdesk.md)。

- **非官方 Windows 集成**：页面终端及指标属于协议适配；桌面查看器是独立的实验入口。
- 增强端为已绑定的 Windows 设备显示独立系统图标；单独使用原版 GMSSH 时仍可能显示 Linux 图标。实际 OS 名称返回 Windows。
- 卡片延迟是到 **本机桥** 的 SSH 延迟，不代表 Windows 网络延迟；“在线”表示本次采集可用，不是独立的可用性监控。
- Windows 可见内存不等于标称物理内存；客户端标为 GB 的展示可能按 GiB 换算。
- 磁盘只列固定逻辑卷，不显示物理 RAID 健康、网络盘或可移动盘。
- 活跃进程数采用 Windows 性能提供者中有非零 CPU 的进程数，与 Linux 的 `R` 状态定义不同。
- 超过 64 个逻辑处理器的系统可能受 Windows processor groups 限制，未验证。
- 最快 2 秒缓存快指标，30 秒缓存慢指标，避免每次界面请求都重复执行昂贵采集。
- GMSSH 的协议没有兼容承诺，升级后可能失效。不要用它替代业务告警系统。
- 文件侧栏只支持单文件上传/下载和目录浏览，尚无文件夹递归传输、断点续传；下载在浏览器内存中组装。
- 当前只支持文本剪贴板；音频、会话录制、隐私屏幕、远程打印和剪贴板文件尚未实现。
- 关机后自动重连和远程硬件唤醒未实机验收。发送唤醒包不代表电脑已经启动。

## 排错

| 现象 | 检查 |
|---|---|
| 连接被拒绝 | 桥是否仍运行、GMSSH 端口是否一致 |
| 密码验证失败 | 用户名是否一致、Windows 密码登录是否正常、known_hosts 是否可信 |
| sudo 提示 | 选择跳过，仅使用监控卡片 |
| 在线但无磁盘 | 查看客户端是否变更协议；本地固定卷是否存在 |
| Collection failed | 使用同一账号测试 PowerShell/CIM/Add-Type，必要时调高 `--timeout` |
| Shell 或 SFTP 请求被拒绝 | 检查相应开关是否启用，目标 Windows 的子系统是否可用 |
| GMSSH 终端提示需要 sudo 或 Bash | 使用 0.2.1+ 的 `--gmssh-terminal`，确认运行的是新桥且端口一致；仅验证了 2.0.4 |
| 升级后显示离线 | 检查协议变化，不要关闭主机密钥验证或伪造指标 |

`--verbose` 仅显示请求类型、响应字节数及错误类型，不输出密码或原始指标。参见 [安全边界](SECURITY.md)。

## 开发与测试

```bash
python -m pip install -e .
python -m unittest discover -s tests -v
```

构建实验桌面查看器时，在 `desktop-web/` 中执行 `npm ci --ignore-scripts` 和 `npm run build`，随后用 `python -m pip install -e '.[desktop]'` 安装其可选传输依赖。默认监控与终端模式不要求此依赖。

测试使用合成数据和模拟 SSH/SFTP 对端，验证协议识别、认证边界、超时、默认拒绝任意命令，以及启用后的转发、输出 EOF、退出码、窗口缩放和文件往返；不需要实际 Windows。可选的实机只读验收：

```bash
python tools/smoke.py --username windows-user --port 22229 \
  --known-hosts ~/.ssh/known_hosts
```

先用普通 SSH 核验本地桥的指纹并加入相应 known_hosts。实机脚本通过隐藏提示读取密码，不接受命令行密码，也不保存密码。

当桥已启用相应能力，可额外验收终端和 SFTP：

```bash
python tools/smoke.py --username windows-user --port 22229 \
  --known-hosts ~/.ssh/known_hosts --exercise-terminal --exercise-sftp
```

`--exercise-sftp` 会在远端用户目录创建唯一临时目录及文件，完成写入、读取、重命名后清理。应仅在允许这些操作的测试账号和主机上运行。前一轮实机记录与本轮自动检查分别见 [验证记录](docs/validation.md)。

## 发布

参见 [发布检查](docs/releasing.md)。仓库仅包含原创适配代码、测试和文档；**不包含 GMSSH 安装包、提取的客户端代码、反汇编、真实凭据或现场日志**。

MIT 许可证仅适用于本项目代码。GMSSH、极目Linux桌面、Windows 等名称属于各自权利人，本项目无隶属或背书关系。
