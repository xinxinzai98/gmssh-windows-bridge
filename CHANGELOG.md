# Changelog

## 0.4.0a8 — 2026-10-15 (friend-test candidate)

- Export source and Mac setup packages from a public file allowlist with checksums; exclude profiles, device catalogs, keys, logs, databases and developer paths.
- Add a generic Mac setup command that builds against the user's installed GMSSH 2.0.4, with no preset Windows target.
- Public Windows bundles retain offline OpenSSH and the unchanged desktop engine; obtain the pinned Microsoft runtime from Microsoft only when the installed runtime does not meet requirements.
- Keep the single-row home toolbar and expose Linux native system version, uptime, process counts and partition usage through the production render data.
- Keep the current local environment separate from distributable packages; this candidate is not a stable-release acceptance claim.

## 0.4.0a7 — 2026-10-15 (development snapshot)

- Import public Windows connection files from the native home page, verify SSH identity, and recognize previously added devices.
- Manage independent monitor/viewer ports and top-row desktop sessions for multiple devices.
- Hand shared first-session credentials to the verified viewer once in memory; retain opt-in Keychain storage.
- Validate actual existing-device import and desktop restoration; fresh-device pairing remains separately pending.

## 0.4.0a6 — 2026-10-14 (development snapshot)

- Add Windows preflight, readiness checks, backup/reinstall and connection-file export.
- Verify the integrated tray, metrics, PowerShell, desktop input and bidirectional file transfer on a Windows 11 test machine.

## 0.4.0a5 — 2026-10-14 (development snapshot)

- Integrate the Windows tray and desktop engine with the enhanced Mac device list and desktop workspace.
- Adapt native Windows card entry, sudo policy, files and power tools.

## 0.3.0 — 2026-10-12 (development snapshot)

- Select the interactive shell with `--shell default|cmd|powershell` without modifying Windows OpenSSH settings.
- PowerShell sessions use UTF-8 output and display the actual working directory in the prompt.
- `--background` detaches the local bridge, checks startup readiness, redirects logs and reports its PID.
- Preserve password/host-key checks and opt-in terminal/SFTP permissions.

## 0.2.1 — 2026-10-12 (development snapshot)

- Opt-in `--gmssh-terminal` compatibility for the GMSSH 2.0.4 page terminal.
- Linux preflight aliases without changing Windows authentication or privileges.
- Fingerprint-based native shell startup and real Windows username probes.
- Verified CMD and PowerShell commands from the GMSSH page on Windows 11.

## 0.2.0 — Unreleased

- Opt-in native Windows SSH exec, interactive terminal/PTY and SFTP forwarding.
- Independent terminal/file channels preserve monitoring on the same connection.
- Read-only Windows login preflight; no Linux profile edits or sudo impersonation.
- Preserve output EOF independently of stdin; retain output arriving after exit status.
- Ship both PowerShell scripts and verify installed-package imports in CI.
- Document the remaining GMSSH 2.0.4 sudo gate and native SSH/SFTP access.

## 0.1.0

- Password-authenticated, loopback-only SSH monitoring bridge.
- Windows CPU, memory, fixed-volume storage and basic system metrics.
- Explicit Linux metrics protocol aliases without changing Windows identity.
- Strict upstream host-key verification, bounded collection, request allowlist.
- No desktop operations, command forwarding or Windows service installation.
