# 指标兼容协议

该文档描述已经验证的互操作格式，不是 GMSSH 的官方协议规范。

## 请求

GMSSH 通过 SSH exec 提交以下形状的请求：

```text
sh -s <<'__GMB_FAST_METRICS__'
# __GMB_FAST_METRICS__
…客户端的 Linux 采集脚本…
__GMB_FAST_METRICS__
```

慢指标对应 `__GMB_SLOW_METRICS__`。桥只验证首行、标记注释和结尾，以及长度上限；忽略整个请求正文，转而执行包内固定 Windows 采集脚本。仅包含某个 marker 的任意命令不会被接受。

## 响应

UTF-8、LF 分行，标量形式为 `__GMB_<NAME>__=<VALUE>`。

| 类别 | 字段 | 来源和单位 |
|---|---|---|
| 快指标 | CPU_TOTAL、CPU_IDLE | GetSystemTimes 累计计数，100ns |
| 快指标 | CPU_USAGE | 1 秒采样差值，0–100%，全 CPU 归一化 |
| 快指标 | MEM_TOTAL_BYTES、MEM_USED_BYTES | Win32_OperatingSystem 可见/空闲内存，换算字节 |
| 慢指标 | OS_KERNEL、OS_NAME | 真实 Windows 版本/名称，加明确协议适配标识 |
| 慢指标 | CPU_CORES | Win32_ComputerSystem 逻辑处理器数 |
| 慢指标 | UPTIME_SECONDS | 当前时间与 LastBootUpTime 的差值 |
| 慢指标 | PROCESS_COUNT | Windows 进程数量 |
| 慢指标 | ACTIVE_PROCESS_COUNT | Windows 中样本 CPU 非零的进程数，非 Linux R 状态 |
| 慢指标 | CID | 空值；不模拟或绕过 GA 授权身份 |

磁盘块由 `__GMB_DISKS_BEGIN__` 和 `__GMB_DISKS_END__` 包围。每行六列，以制表符分隔：

```text
设备别名  文件系统  总块数  块字节数  可用块数  挂载点
```

Windows 直接使用字节计数，因此块字节数为 `1`。例如 C: 的设备别名是 `/dev/windows/C`，实际挂载点仍为 `C:\`，文件系统仍为 `NTFS`。客户端计算 `总量 = 总块数 × 块字节数`、`已用 = (总块数 - 可用块数) × 块字节数`。

## 两个兼容性限制

已验证的客户端会拒绝 OS/内核描述中不含 `linux` 的结果，同时过滤不以 `/dev/` 开头的磁盘设备名。因此使用明确的 `Windows … (Linux metrics protocol adapter)` 描述和 `/dev/windows/<盘符>` 协议别名。

这不会赋予 Windows Linux 的能力，也不会影响目标 Windows 配置。首页的 Linux 图标和本机连接延迟属于客户端展示限制。

## 可选原生 SSH 转发

| 请求 | 启用条件 | 处理 |
|---|---|---|
| 已识别的快/慢指标 exec | 始终可用 | 固定只读 Windows 采集器 |
| GMSSH 登录前置探测 | `--enable-terminal` | 固定 `login.ps1`，返回实际用户、Windows 系统和 sudo 不可用状态 |
| 其他 exec、shell、PTY、窗口缩放 | `--enable-terminal` | 原样转发到目标 Windows OpenSSH |
| 2.0.4 固定 Bash 终端启动 exec | `--gmssh-terminal` | 精确匹配请求指纹，转接 Windows 原生 shell |
| `id -nu` / `id -un` | `--gmssh-terminal` | 固定只读探测，返回真实 Windows 用户名 |
| `sftp` subsystem | `--enable-sftp` | 透明转发二进制 SFTP 数据 |
| 其他 subsystem、端口转发 | 不提供 | 拒绝 |

标准输入 EOF 和远端输出 EOF 分别传递；退出码先于最终输出到达时，仍继续转发到输出结束。每条执行/文件通道独立处理，监控采集另行缓存，同一连接最多四条并发会话通道。

`--gmssh-terminal` 仅在登录探测响应中将 `SUDO` / `SUDO_ACCESS` 改为 `1`，保留实际用户名及 `SUDO_PASSWORD=0`。这是 Linux 协议前置条件的适配标志，不代表目标 Windows 具有 sudo/root，也不改变 Windows 权限。没有启用此模式时，这些探测字段仍为 `0`。

2.0.4 启动请求的指纹来自实机捕获的 SSH exec 字节串；不执行或发布其 Bash 正文。该模式已经验证页面终端。页面文件管理、桌面应用部署、root/sudo、Linux 服务及 Agent 管理均未验收或不支持，不能宣称完整 GMSSH 桌面兼容。
