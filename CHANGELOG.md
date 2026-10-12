# Changelog

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
