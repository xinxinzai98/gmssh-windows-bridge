# 免费 RustDesk 桌面接入（0.4.0a3 实验版）

用户选择在 GMSSH 页面中显示并操作 Windows 的真实桌面，并优先使用免费方案。本版选择 **小型开源 Web 查看器 + 已验证主机密钥的 SSH 隧道 + Windows 上的 RustDesk**。无需 RustDesk Server Pro、独立 ID/中继服务器或第三方公共查看器。

```text
GMSSH 网页容器 / 浏览器
    → 本机回环 WebSocket
    → Windows OpenSSH（原有账号，校验 known_hosts）
    → Windows 的 127.0.0.1:21118
    → RustDesk 直接 IP 协议 → 用户桌面
```

## 当前完成范围

浏览器组件采用 Kessoku 项目的 MIT 协议编解码、VP9 WebCodecs 解码与基本键盘辅助代码。原始出处固定在 `desktop-web/vendor/UPSTREAM.md`，保留 MIT 和 Protobuf 依赖的完整许可。连接状态机、本地 SSH 传输及页面为本项目新增代码，不包含 RustDesk 商业 Web V2 资源，也没有引入 Kessoku 的账号、数据库、ID 或中继服务栈。

目前支持密码挑战应答、当前显示器的 VP9 画面、鼠标、基本键盘和主动断开。独立浏览器支持全屏；内嵌模式采用“放大画面/恢复面板”，在 iframe 内铺满画面。不支持音频、剪贴板、文件传输、显示器切换。中文输入法、UAC/安全桌面、复杂组合键尚未验收。需要支持 VP9 WebCodecs 的现代 Chromium 安全上下文；本轮已在 GMSSH 2.0.4 的实际 iframe 中解码真实画面。

这是 **0.4.0a3 开发预览**。已发布的 0.3.0 继续提供终端、SFTP 和监控。真实 Windows RustDesk 会话及 GMSSH 页面内的临时桌面按钮已完成基本联调；入口仍需手动激活，未提供持久化客户端插件。

## 启动

使用带桌面静态资源的构建包，安装可选依赖：

```bash
python -m pip install '.[desktop]'
```

随现有桥启动：

```bash
gmssh-windows-bridge --target windows-host --username windows-user \
  --known-hosts /path/to/trusted-known-hosts \
  --gmssh-terminal --shell powershell --desktop-port 22240 --background
```

浏览器打开 `http://127.0.0.1:22240/`。SSH 入口的端口仍由 `--listen-port` 控制，两者必须不同。桌面窗口需分别验证原有 Windows SSH 密码和 RustDesk 密码；RustDesk 密码留空时可在 Windows 端确认连接，最多等待 5 分钟。页面会清空密码输入，不保存凭据。状态区区分 SSH 验证、RustDesk 登录请求和实际收到画面。

也可以独立测试桌面服务：

```bash
gmssh-windows-desktop --target windows-host --username windows-user \
  --known-hosts /path/to/trusted-known-hosts --listen-port 22240
```

默认 RustDesk 目标端口为 `21118`，可通过 `--rustdesk-port` 指定该 Windows 主机上的另一个直接访问端口。此参数由启动者配置，网页不能改写目标主机、账号或端口。

Windows 上需要 RustDesk 程序已启动、直接 IP 访问已启用，并能访问真实用户桌面；SSH 需允许转发到该本机端口。本桥不自动安装程序、修改 RustDesk 认证、启用端口或开放防火墙。RustDesk 的监听范围和服务模式需在 Windows 部署时单独核对。

## GMSSH 临时入口

GMSSH SDK 提供自定义网页窗口，纯前端应用无需 `init()` 启动服务。服务的 `frame-ancestors` 允许本机回环和 `file:` 来源；本轮使用实际 GMSSH 页面中的 iframe 完成了画面和基本输入联调。

在 2.0.4 的公开 SDK 中未找到按机器替换原生“桌面”按钮的接口。`desktop-web/public/gmssh-entry.js` 提供当前页面内的临时挂接：只拦截指定机器的桌面按钮，在可关闭的 iframe 面板中加载回环查看器。它不修改 GMSSH 安装包、不部署 Linux Agent，也不读取账号数据。刷新页面或重启客户端后，需要重新激活。

先审阅该脚本，再从 GMSSH 的 `View → Toggle Developer Tools → Console` 激活。开发控制台如果显示粘贴安全警告，应由操作者亲自处理。页面没有 Node.js 的 `require`；桌面服务通过 HTTP 提供同一份通用脚本，使用标准浏览器加载方式：

```javascript
(() => {
  const script = document.createElement("script");
  script.src = "http://127.0.0.1:22240/gmssh-entry.js";
  script.onload = () => installWindowsDesktopEntry({
    machineId: "your-windows-machine-id",
    viewerUrl: "http://127.0.0.1:22240/",
  }).open();
  document.head.append(script);
})();
```

必须使用机器记录的准确 ID；这里的占位值不能直接使用。`removeWindowsDesktopEntry()` 可恢复当前页面的按钮行为并关闭面板。不同 GMSSH 版本可能不提供所需的 `data-machine-id` / `data-machine-action` 属性，正式使用前需验证实际页面。先前的 `examples/rustdesk-desktop/index.html` 只演示 iframe 承载，不是本版选定的免费协议客户端。

## 验证与完成条件

自动检查覆盖既有终端、SFTP、后台运行，以及桌面分帧、双向传输、来源/Host/路径限制、目标主机密钥验证和两个本地监听的后台启动。本地浏览器协议模拟器通过了独立密码向量验证、三个 VP9 测试帧、视频 ACK、鼠标按下/抬起和键盘按下/抬起；模拟画面明确标注为测试，不是 Windows 桌面。

2026-10-12，在已授权的 Windows 11 试验机安装官方 RustDesk 1.5.0（安装文件哈希匹配、Authenticode 签名有效），回读服务运行和直接 IP 监听。ID/中继端点设为本机回环，访问白名单为 `127.0.0.1`；通过 SSH 连接其 `127.0.0.1:21118`，使用正常 RustDesk 主窗口的一次性密码完成登录，没有修改永久密码。

真实会话已显示 Windows 桌面；鼠标点击、快捷键、字母/空格/数字输入、窗口最大化、全屏及退出、主动断开和重新连接均通过。默认解码偏好下曾出现记事本块状残影；优先软件 VP9 解码后，同一窗口、文字输入和最大化画面完整。该结果仅覆盖本轮 Chromium 主机，不代表所有 GPU、驱动和长期会话已通过。

SSH 通道打开确认不能证明 RustDesk 正在监听，客户端只有在 RustDesk 批准登录并解码出画面后才显示相应状态。设备身份、截图和现场日志仅存于工作区私有记录。

随后在 GMSSH 2.0.4 的实际机器列表激活临时脚本，由正常 RustDesk 连接弹窗批准会话，收到真实画面。桌面按钮关闭后可重新打开；放大画面、恢复面板后画面完整，监控卡片继续刷新。曾发现系统全屏返回后窗口裁切，因此内嵌模式改用页内放大。已有终端与 SFTP 的协议回归通过，本轮没有重新操作其他机器的用户终端。

自动逐键和快速批量输入曾出现乱序或漏字，来源尚未定位；基本输入的通过结果不能代表高速连打可靠性。持久化客户端入口、中文输入法、UAC/管理员窗口和长期运行仍待验收，全部所需检查通过后再发布稳定版本。

## 依据与许可

- [Kessoku MIT Web 客户端及功能边界](https://github.com/q1ngyang/rustdesk-api-kessoku/tree/edfdd5b07f04bac6c3cdf96036fe9cb69164fb8d/web-client)
- [RustDesk 1.5.0 的直接 IP 连接路径](https://github.com/rustdesk/rustdesk/blob/1.5.0/src/client.rs)
- [RustDesk 原生 TCP 分帧](https://github.com/rustdesk/hbb_common/blob/master/src/bytes_codec.rs)
- [GMSSH 自定义网页窗口](https://doc-dev.gmssh.com/web_sdk/api.html#打开自定义窗口)
- [GMSSH 纯前端应用无需 init](https://doc-dev.gmssh.com/web_sdk/sdk_init.html)

官方公共 `rustdesk.com/web` 设置了 `SAMEORIGIN`，官方自托管 Web V2 有 Pro 套餐门槛；这也是选择独立 MIT 客户端的原因，见 [官方说明](https://rustdesk.com/blog/rustdesk-web-client-v2-preview/)。本项目 MIT 许可证仅覆盖本项目代码；上述第三方源码和依赖按各自许可分发。Windows RustDesk 程序由官方单独提供，不包含在本 Python 包中。
