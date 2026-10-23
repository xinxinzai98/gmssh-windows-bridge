#!/bin/bash
set -euo pipefail
umask 077
setup_dir="$(cd "$(dirname "$0")" && pwd)"
[[ "$(uname -s)" == Darwin ]] || { printf '此更新器需要 macOS。\n' >&2; exit 1; }
(cd "$setup_dir" && /usr/bin/shasum -a 256 -c SHA256SUMS)
wheels=("$setup_dir"/gmssh_windows_bridge-*.whl)
[[ ${#wheels[@]} -eq 1 && -f "${wheels[0]}" ]] || { printf '请完整解压更新包，wheel 文件缺失或不唯一。\n' >&2; exit 1; }
support="$HOME/Library/Application Support/gmssh-windows-bridge"
bootstrap=''
for candidate in "$(command -v python3 || true)" /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 "$support"/*/bin/python "$support"/*/*/bin/python; do
  [[ -x "$candidate" ]] || continue
  if "$candidate" -I -c 'import sys; raise SystemExit(sys.version_info < (3,9))' >/dev/null 2>&1; then bootstrap="$candidate"; break; fi
done
[[ -n "$bootstrap" ]] || { printf '未找到可用的现有 Python；请在本机开发环境中执行更新。\n' >&2; exit 1; }
"$bootstrap" -I -c 'import runpy,sys; wheel=sys.argv.pop(1); sys.path.insert(0,wheel); sys.argv[0]="gmssh-mac-update"; runpy.run_module("gmssh_windows_bridge.macos_update",run_name="__main__")' "${wheels[0]}" --wheel "${wheels[0]}" "$@"
