# GMSSH Windows Bridge

**让 Windows 的真实 CPU、内存和磁盘指标显示在 GMSSH / 极目Linux桌面的机器卡片中。**

非官方、实验性、只读兼容项目。无需修改 GMSSH 客户端，也不把 Windows 伪装成一台完整的 Linux 服务器。

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
| GMSSH 终端、SFTP、桌面应用、sudo、服务管理 | 不支持，明确拒绝 |
| Windows 原生安装包、开机启动服务 | 尚未实现 |
| 多台 Windows | 每台运行一个实例，使用不同本地端口 |

首个原型已在 **Apple Silicon macOS + Windows 11 25H2 + GMSSH 2.0.4**上验证机器卡片的动态 CPU、内存和磁盘显示。此结果不代表所有客户端版本都兼容，也不代表本项目获得官方支持。兼容依据见 [协议说明](docs/protocol.md)。

## 环境要求

- 运行桥的电脑：Python 3.10+，可访问目标 Windows 的 SSH 端口。
- 目标 Windows：OpenSSH Server 已配置，现有账号允许密码登录，可运行 Windows PowerShell 5.1、CIM 和 `Add-Type`。
- 网络：局域网或已配置的 Tailscale 等私有网络。本项目不安装 VPN，也不自动开放防火墙。
- 只支持密码认证。桥将 GMSSH 输入的账号密码用于目标认证，**不落盘**；GMSSH 自身保存凭据的行为另计。

## 快速开始

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

测试连接后添加。如果客户端询问 Linux sudo 密码，选择 **跳过**。Windows 不存在对应的 sudo 密码，不要修改 Windows 账号或赋予额外权限来通过这个界面。

保持桥进程运行，刷新机器列表。按 `Ctrl-C` 停止；停止后该试验条目会显示离线，原来的 Windows SSH 服务不受影响。

### 主机密钥与迁移

桥首次启动生成自己的 SSH 主机密钥，默认位置是 `~/.gmssh-windows-bridge/host_key`。保留它以免客户端提示主机身份变化；不要提交到 Git。可用 `--host-key PATH` 指定独立密钥。修改 `--target` 后应新建对应条目和密钥，避免同一入口悄悄指向另一台机器。

### 多台机器

分别启动多个进程，例如端口 `22229`、`22230`，各自指定目标、用户名和独立 `--host-key`。在 GMSSH 建立相应条目。当前版本不提供后台进程管理。

## 必须知道的限制

- **不是原生 Windows 管理插件**：仅兼容机器卡片的指标协议。
- 客户端可能显示 Linux 企鹅图标，因为其系统识别逻辑仅面向 Linux。实际 OS 名称仍返回 Windows，并明确注明协议适配。
- 卡片延迟是到 **本机桥** 的 SSH 延迟，不代表 Windows 网络延迟；“在线”表示本次采集可用，不是独立的可用性监控。
- Windows 可见内存不等于标称物理内存；客户端标为 GB 的展示可能按 GiB 换算。
- 磁盘只列固定逻辑卷，不显示物理 RAID 健康、网络盘或可移动盘。
- 活跃进程数采用 Windows 性能提供者中有非零 CPU 的进程数，与 Linux 的 `R` 状态定义不同。
- 超过 64 个逻辑处理器的系统可能受 Windows processor groups 限制，未验证。
- 最快 2 秒缓存快指标，30 秒缓存慢指标，避免每次界面请求都重复执行昂贵采集。
- GMSSH 的协议没有兼容承诺，升级后可能失效。不要用它替代业务告警系统。

## 排错

| 现象 | 检查 |
|---|---|
| 连接被拒绝 | 桥是否仍运行、GMSSH 端口是否一致 |
| 密码验证失败 | 用户名是否一致、Windows 密码登录是否正常、known_hosts 是否可信 |
| sudo 提示 | 选择跳过，仅使用监控卡片 |
| 在线但无磁盘 | 查看客户端是否变更协议；本地固定卷是否存在 |
| Collection failed | 使用同一账号测试 PowerShell/CIM/Add-Type，必要时调高 `--timeout` |
| 升级后显示离线 | 检查协议变化，不要关闭主机密钥验证或伪造指标 |

`--verbose` 仅显示请求类型、响应字节数及错误类型，不输出密码或原始指标。参见 [安全边界](SECURITY.md)。

## 开发与测试

```bash
python -m pip install -e .
python -m unittest discover -s tests -v
```

测试使用合成数据和模拟 SSH 对端，验证协议识别、认证边界、超时和拒绝任意命令；不需要实际 Windows。可选的实机只读验收：

```bash
python tools/smoke.py --username windows-user --port 22229 \
  --known-hosts ~/.ssh/known_hosts
```

先用普通 SSH 核验本地桥的指纹并加入相应 known_hosts。实机脚本通过隐藏提示读取密码，不接受命令行密码，也不保存密码。

## 发布

参见 [发布检查](docs/releasing.md)。仓库仅包含原创适配代码、测试和文档；**不包含 GMSSH 安装包、提取的客户端代码、反汇编、真实凭据或现场日志**。

MIT 许可证仅适用于本项目代码。GMSSH、极目Linux桌面、Windows 等名称属于各自权利人，本项目无隶属或背书关系。
