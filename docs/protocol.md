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

这不会赋予 Windows Linux 的能力，也不会影响目标 Windows 配置。首页的 Linux 图标和本机连接延迟属于客户端展示限制。仅验证监控卡片，不支持桌面应用部署、root/sudo 或文件管理。
