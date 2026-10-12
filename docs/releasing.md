# 发布检查

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
python -m pip install --force-reinstall --no-deps dist/gmssh_windows_bridge-0.3.0-py3-none-any.whl
python -I -m gmssh_windows_bridge --help
python -I -m gmssh_windows_bridge --version
```

许可证为 MIT。构建、检查和本地文件交付与 GitHub 推送、创建 tag/Release 分开进行；远端 CI 的结果须从实际运行记录确认。
