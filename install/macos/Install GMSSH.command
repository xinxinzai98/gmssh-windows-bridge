#!/bin/bash
set -euo pipefail
umask 077
setup_dir="$(cd "$(dirname "$0")" && pwd)"
fail() { printf '\n%s\n' "$1" >&2; exit 1; }
trap 'printf "\n安装未完成，现有连接和原版 GMSSH 已保留。\n" >&2' ERR
runtime_stage=''
cleanup() { if [[ -n "$runtime_stage" && -d "$runtime_stage" ]]; then rm -rf -- "$runtime_stage"; fi; }
trap cleanup EXIT

[[ "$(uname -s)" == Darwin ]] || fail '此安装器需要 macOS。'
(cd "$setup_dir" && /usr/bin/shasum -a 256 -c SHA256SUMS)
python_bin=''
for candidate in "$(command -v python3 || true)" /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [[ -n "$candidate" && -x "$candidate" && "$candidate" != /usr/bin/python3 ]] || continue
  if "$candidate" -I -c 'import sys; raise SystemExit(not ((3,12) <= sys.version_info < (3,15)))' >/dev/null 2>&1; then python_bin="$candidate"; break; fi
done
vendor_app='/Applications/极目Linux桌面.app'
[[ -d "$vendor_app" ]] || fail '请先在 /Applications 安装原版 GMSSH 2.0.4：https://www.gmssh.com/'
vendor_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$vendor_app/Contents/Info.plist")
[[ "$vendor_version" == 2.0.4 ]] || fail "当前原版版本为 $vendor_version，本 Alpha 预览版只验收了 2.0.4。"
/usr/bin/codesign --verify --deep --strict "$vendor_app"
wheels=("$setup_dir"/gmssh_windows_bridge-*.whl)
[[ ${#wheels[@]} -eq 1 && -f "${wheels[0]}" ]] || fail '安装包中的 wheel 缺失或不唯一，请完整解压后重试。'
if [[ "${1:-}" == --check ]]; then printf '前置检查通过；未安装或修改任何应用。\n'; exit 0; fi

if [[ -z "$python_bin" ]]; then
  arch="$(uname -m)"
  [[ "$arch" == arm64 || "$arch" == x86_64 ]] || fail '尚不支持此 Mac 架构。'
  metadata="$setup_dir/python-runtime.plist"
  python_version=$(/usr/libexec/PlistBuddy -c 'Print :version' "$metadata")
  python_url=$(/usr/libexec/PlistBuddy -c "Print :$arch:url" "$metadata")
  python_sha=$(/usr/libexec/PlistBuddy -c "Print :$arch:sha256" "$metadata")
  [[ "$python_url" == https://github.com/astral-sh/python-build-standalone/releases/download/* && "$python_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'Python 下载清单无效。'
  python_root="$HOME/Library/Application Support/gmssh-windows-bridge/python-$python_version-$arch"
  if [[ ! -e "$python_root" ]]; then
    printf '正在准备独立 Python 运行环境，不修改系统 Python…\n'
    runtime_stage=$(mktemp -d "${TMPDIR:-/tmp}/gmssh-python.XXXXXXXX")
    /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 "$python_url" --output "$runtime_stage/python.tar.gz"
    actual_sha=$(/usr/bin/shasum -a 256 "$runtime_stage/python.tar.gz" | cut -d' ' -f1)
    [[ "$actual_sha" == "$python_sha" ]] || fail 'Python 运行环境校验失败。'
    /usr/bin/tar -tzf "$runtime_stage/python.tar.gz" | /usr/bin/awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}'
    /usr/bin/tar -xzf "$runtime_stage/python.tar.gz" -C "$runtime_stage"
    [[ -x "$runtime_stage/python/bin/python3" ]] || fail 'Python 运行环境结构无效。'
    mkdir -p "$(dirname "$python_root")"
    mv "$runtime_stage/python" "$python_root"
  fi
  python_bin="$python_root/bin/python3"
  [[ -x "$python_bin" ]] || fail '已有 Python 运行环境不完整，已保留现场。'
fi

app_output="$HOME/Applications/GMSSH 局域网增强端.app"
[[ ! -e "$app_output" ]] || fail '已存在 GMSSH 局域网增强端。请保留现有版本，并按下载页的升级说明处理。'
version="$(basename "${wheels[0]}" | cut -d- -f2)"
runtime="$HOME/Library/Application Support/gmssh-windows-bridge/runtime-$version"
printf '正在安装 GMSSH 增强组件，需要访问 PyPI 下载依赖…\n'
if [[ -e "$runtime" ]]; then
  [[ -f "$runtime/.gmssh-installer-owned" && -x "$runtime/bin/python" && "$(cat "$runtime/.gmssh-installer-owned")" == "$version" ]] || fail '该版本运行环境已存在且无法确认来源，已保留现场。'
else
  "$python_bin" -I -m venv "$runtime"
  printf '%s\n' "$version" > "$runtime/.gmssh-installer-owned"
fi
"$runtime/bin/python" -I -m pip --isolated install --only-binary=:all: --index-url https://pypi.org/simple \
  --constraint "$setup_dir/requirements-macos.txt" "${wheels[0]}[desktop]"
"$runtime/bin/python" -I -m gmssh_windows_bridge.macos_launcher \
  --pairing-only --keychain --gmssh-app "$vendor_app" \
  --profile "$HOME/Library/Application Support/gmssh-windows-bridge/controller" --output "$app_output"
printf '\n安装完成。请退出其他 GMSSH 实例后打开：%s\n首次使用请正常允许系统的局域网访问。\n' "$app_output"
