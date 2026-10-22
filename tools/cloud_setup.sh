#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

gmssh_python="${GMSSH_SETUP_PYTHON:-python3}"
"$gmssh_python" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is required"'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node.js 22.12+ is required")'
npm --version
GOTOOLCHAIN=go1.27.2 go version

"$gmssh_python" -m venv .venv
.venv/bin/python -m pip install -e '.[desktop,ai]'
(cd desktop-web && npm ci --ignore-scripts)
printf '%s\n' 'Setup complete. Run: bash tools/cloud_check.sh quick (or full).'
