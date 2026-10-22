#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

gmssh_mode="${1:-quick}"
case "$gmssh_mode" in
  quick|full) ;;
  *) printf '%s\n' 'Usage: bash tools/cloud_check.sh [quick|full]' >&2; exit 2 ;;
esac
gmssh_python="${GMSSH_TEST_PYTHON:-$PWD/.venv/bin/python}"
export GMSSH_TEST_PYTHON="$gmssh_python"
"$gmssh_python" -m gmssh_windows_bridge --version

if [[ "$gmssh_mode" == quick ]]; then
  "$gmssh_python" -m unittest discover -s tests -p 'test_launcher.py' -v
  "$gmssh_python" -m unittest discover -s tests -p 'test_share_bundle.py' -v
  node --experimental-vm-modules --test --test-concurrency=1 \
    tests/test_launcher_startup.cjs tests/test_windows_machine_policy.cjs tests/test_workspace.cjs
else
  export GOTOOLCHAIN=go1.27.2
  "$gmssh_python" -m gmssh_windows_bridge.ai --help
  "$gmssh_python" -m unittest discover -s tests -v
  (cd desktop-web && npm run build)
  node --experimental-vm-modules --test --test-concurrency=1 tests/*.cjs
  (cd tools/windows_connect && GO111MODULE=off go test -v)
  (cd tools/windows_installer && go test extract.go extract_test.go)
  "$gmssh_python" tests/ai_controller_integration.py --go go
fi
"$gmssh_python" tools/build_share_bundle.py --check-only
