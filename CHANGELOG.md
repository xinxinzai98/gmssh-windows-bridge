# Changelog

## Unreleased

- Develop 0.4.0a17 locally (stage 2B): move transfer ownership and a private atomic journal into the Mac main process. Stream through granted file descriptors in 64 KiB chunks, retain partial files, and restore unfinished tasks as paused without automatically accessing historical local paths.
- Resume uploads and downloads after verifying pinned SSH identity, source metadata, full SHA-256 and the existing prefix. Re-authorize local files after reopening; verify the saved download again before a no-overwrite commit, and recover interrupted final commits or a lost upload acknowledgement.
- Support native file/folder pickers, confirmed drag uploads, hierarchy-preserving folder downloads, pause/continue, partial cleanup and explicit disk/permission/conflict failures. Raise only the native path to 1 TiB per file; retain the bounded 512 MiB/ZIP browser fallback and native Linux tool.

- Develop 0.4.0a16 locally (stage 2A): move Windows file transfers into a separate, retained file workspace. Device-card and desktop-toolbar file actions open the same center without starting RustDesk; each device retains its own browser and queue when hidden or when its desktop closes.
- Coordinate file tasks in order across devices within a management window; acknowledge active work in main before granting I/O, close each task's own file channel, and preserve monitoring/desktop leases. Add an all-device task summary and a stop-or-continue prompt on application exit.
- Retain existing selection, folders, ZIP downloads, progress, cancellation, retry and conflict renaming. At 0.4.0a16, keep the 512 MiB limit and browser-save behavior, without application-exit recovery; the 0.4.0a17 native path above supersedes those limits. Linux continues through its native file tool with this scope stated in the center.
- Develop 0.4.0a15 locally: add per-device connection diagnostics and read-only process, service and log tools for Windows and Linux. Reuse authenticated monitoring SSH or an existing native Linux session; no automatic login, provisioning, privilege changes or new remote listener.
- Separate TCP reachability, pinned identity, observed authentication, monitoring, SFTP, RustDesk handshake, approval and first-frame/frame reception. Export only allowlisted versions, stage codes and timestamps; never include addresses, credentials or log contents.
- Bound and validate queries, send packaged Windows scripts over SSH stdin to avoid default-shell command-length limits, load log details on demand and retain explicitly stale data after failed refreshes. Display unsupported tools and CPU/memory sampling definitions explicitly.
- Develop 0.4.0a14 locally: export and import selected Linux/Windows connections, preserving groups and selected bastion dependencies. Ordinary files omit credentials; optional backups encrypt saved SSH passwords and keys with a user-supplied passphrase. Imports preview selections, retain existing devices and report partial failures.
- Generate standard text QR codes in the Windows sharing panel, with copy/save image actions; scan a camera or a local image in the controller's existing Add Machine flow. Decoding is local and still requires the normal device-identity preview before enrollment.
- Develop 0.4.0a13 locally: clarify existing-device enrollment and preserve its displayed name; add masked direct code paste and public connection-file drag-in.
- Probe the authenticated remote SSH TCP endpoint instead of presenting loopback bridge latency; keep unknown and failed collection states explicit.
- Add a scrollable device-details dialog and complete per-device actions for narrow windows.
- Add multiple-file and folder upload, drag-in, transfer tasks, progress, cancellation, conflict rename/retry, batch selection and bounded folder ZIP downloads without overwriting existing files.
- Commit Chinese input-method text once, support explicit local text paste, and retain remote Ctrl+V clipboard behavior.
- Report SSH, desktop and connection-code service health separately; inspect the pinned local TLS endpoint and encrypted store without account-login attempts.
- Align Windows enrollment fields, keep address and SSH port on one row, group the three input methods with icons, and keep the current step's action outside the scrolling form.
- Put Linux and Windows enrollment inside the native plus-button Add Machine dialog; remove the separate Windows toolbar button and preserve the original Linux form, tests and advanced settings.
- Clear temporary Windows credentials when changing platforms or closing the native dialog; keep a single modal and block dismissal while an enrollment operation is pending.
- Accept supplied IPv6 targets in manual enrollment, public connection files and long-lived codes, with unambiguous bracketed endpoint parsing and separate SSH ports.
- Edit an existing Windows device's address from its context menu; verify its pinned SSH identity and password before replacing the connection, retain its card and local ports, and restore the old connection if replacement fails.
- Use the verified SSH device identity for desktop Keychain accounts, retaining access to previously saved address-based entries only for the same pinned key.
- Listen for connection-code HTTPS on both address families, retaining default subnet firewall rules and requiring an explicit source policy for additional public IPv6 clients.
- Preserve full IPv6 values in address tooltips and copy actions; exclude generated conflict copies from clean public exports while retaining local files.
- Add reusable, long-lived LAN connection codes: copy from the Windows tray, paste into the Mac controller, and retain manual enrollment.
- Exchange credentials only after SSH identity and a pinned device TLS certificate are verified; keep passwords out of the code and codes out of the device catalog, URLs and logs.
- Protect the Windows credential store with DPAPI and restricted ACLs; invalidate old codes on password changes or an explicit reset, and retain existing cards on re-enrollment.
- Add a Windows upgrade/repair path with owned-file backups and rollback, retaining existing accounts, credentials, SSH identity and desktop engine.
- Check the original tray logon principal and export a limited startup status report after sign-in.
- Refresh credentials on the exact existing device record and reopen its desktop using a one-use in-memory credential.
- Require initialized native GMSSH server resources on Mac, register the installed launcher, and send pointer positions before fast mouse clicks.
- Close the local SSH transport when its Windows upstream disconnects, so clients can discard stale sessions after a restart.
- Reopen a disconnected desktop from its original device button using available saved authentication, without submitting typed credentials or duplicating sessions.
- Keep ordinary offline connection retries non-modal while retaining dialogs for access and host-identity failures.
- Keep desktop connection settings open during live frame updates so disconnect remains usable.
- Reorganize the project homepage, installation and CLI documentation, and contributor entry points.
- Standardize public release terminology as Alpha preview; existing 0.4.0a8 artifacts remain unchanged.

## 0.4.0a8 — 2026-10-15 (Alpha preview)

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
