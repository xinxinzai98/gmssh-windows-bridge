# 发布检查

1. 确认只发布当前独立目录，**不要把它的父目录设备维护推到 GitHub**。
2. 运行单元测试和构建；检查 wheel 包含 `collector.ps1`。
3. 检查 `git status` 和待提交文件：不得包含账号密码、内网/公网真实资产地址、host_key、known_hosts、现场日志、虚拟环境、GMSSH 二进制或提取材料。
4. README 中区分实机验证与模拟测试。兼容客户端版本变化需要重新实测，不凭测试用假数据宣称兼容。
5. 创建仓库时使用名称 `gmssh-windows-bridge` 或自行选择；添加 MIT 许可证及非官方说明。不要声称获得 GMSSH 官方支持。
6. 开启 GitHub 私密漏洞报告功能，填写维护者信息；先发布预发行版 `v0.1.0-alpha.1`。

初次提交示例（只在本目录执行，需先审查文件）：

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial read-only Windows metrics bridge"
git remote add origin <你的GitHub仓库地址>
git push -u origin main
```

不要把尖括号占位地址原样执行。首次发布前尚需维护者决定是否使用当前 MIT 许可证，以及实际仓库所属账号。
