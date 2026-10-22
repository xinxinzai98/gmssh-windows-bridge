# Repository guidance

## Scope and source

- This repository contains the GMSSH enhancement extension, Python bridge, Windows scripts and helper, and CLI/MCP integration. It does not contain the original GMSSH application's source or a redistributable complete Mac app.
- Edit frontend sources in `desktop-web/`. `npm run build` also updates the committed mirror in `gmssh_windows_bridge/desktop_web/`; include both source and generated changes. Do not edit only generated bundles.
- Python code lives in `gmssh_windows_bridge/`; the Electron wrapper is `gmssh_windows_bridge/launcher.cjs`. Windows tray/setup scripts are in the same package; Go helper sources are in `tools/windows_connect/` and `tools/windows_installer/`.
- Preserve existing work. Keep changes focused, use existing fixtures, and avoid creating full application copies or new runtime stacks for ordinary development.

## Setup and checks

- Read `CONTRIBUTING.md` and `docs/cloud-development.md` first. Recommended environment: Python 3.12+, Node.js 22.12+, npm, and Go 1.27.2 (the version used by the current workflow).
- Install with `bash tools/cloud_setup.sh`. It creates a repository-local `.venv` and installs Python desktop/AI dependencies and locked frontend dependencies; no production credentials are needed.
- Run `bash tools/cloud_check.sh quick` for launcher/shell-related edits, then the tests relevant to other affected components. Run `bash tools/cloud_check.sh full` for the complete portable regression suite before handing off broader changes.
- The frontend build replaces its output directory. Keep personal files and sync-conflict copies outside that directory before rebuilding; do not delete existing local files as part of a code task.

## Boundaries

- Cloud work is source, build, and synthetic-test work. Tests may use disposable loopback services and temporary files. Do not connect to real devices or import live profiles, passwords, tokens, host keys, connection codes, databases, screenshots, or logs.
- Do not install or launch a Mac app or Windows installer, change machine settings, deploy, reboot, unlock a device, or adjust firewall/network rules as part of cloud development. Native acceptance is a separate authorized local step.
- Preserve host-key/certificate pinning, per-controller permissions, revocation, file access restrictions, and credential storage boundaries. A successful mock or build does not prove native desktop, credential, reboot, or installer behavior.
- Do not publish the original GMSSH bundle, installed apps, proprietary resources, or local runtimes. Run `python tools/build_share_bundle.py --check-only` before handoff and review the actual diff for private information.
- Report passed checks, platform skips, and untested behavior separately. Do not claim that a local check is a successful cloud CI run or a release.

## Pending UI clarification

The request to merge "two rows" into one has not been located. The user rejected the proposed tab/device bars, device name/status, and group/toolbar interpretations. Do not merge any of those rows without a screenshot identifying the intended elements. The local Mac menu's legacy name also needs helper-resolution analysis before changing `CFBundleName`.
