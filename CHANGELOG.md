# Changelog

## Unreleased

- Prepare 0.4.0a34 as one Windows/Mac candidate with the credential-validation, progress/result feedback and guarded optional Windows unlock fixes already exercised on the independent Windows test host. Pin the unmodified RustDesk 1.5.1+68 nightly by official asset, installer digest, complete file-manifest digest and the actual upstream build commit. Preserve existing engines during normal upgrades.
- Reject mismatched source/project/wheel versions, incomplete wheel contents, stale Windows scripts/brands/licenses/dependency pins, changed offline OpenSSH installers and modified desktop-engine payloads during public export. Reject duplicate, missing and extra bundle entries. A preserved uninstall/reinstall is physically verified; pristine-system installation remains a separate coverage boundary, and publication requires successful CI.
- Add a Windows Settings uninstall entry with a scoped preview, recoverable program backup, owned task/rule removal and preserved configuration. Reinstallation validates the backup and original account before restoring; existing SSH/RustDesk stay intact, and only a verified GMSSH-created account/internal engine can be disabled or removed. The actual preserved upgrade/uninstall/reinstall cycle passed with original services, account, credentials and independent grants retained. Windows-native synthetic transactions cover rollback and the managed-account/internal-engine branches.
- Verify installed CLI/MCP access and a unique Notepad document's Unicode multiline input, save, full content/hash and reopen after reinstall. A taskbar provider that cannot acquire focus or expose Invoke still fails explicitly rather than sending input to another window.
- Confirm Windows unlock results through the existing authenticated desktop context without reading the Windows password again. Distinguish an unlocked session, lock/secure desktop, lost authorization and an unconfirmed result; verify the updated isolated Mac GUI against a real unlocked desktop.
- Complete 25 native file-policy checks using two temporary grants: invalidate writable sessions after downgrade, deny raw writes under read-only policy, reject revoked sessions and reconnects, and preserve an independent concurrent reader. Revoke both test grants afterward and retain the original authorization and encrypted credentials.
- Replace expired pinned HTTP connections before sending a request. Fix the real idle-then-reconnect failure without retrying or replaying commands or file writes; account conservatively for long responses and verify the installed client after an idle interval.
- Store non-ASCII PowerShell source as UTF-8 with BOM so Windows PowerShell 5.1 parses the checkout consistently with the installer payload.

- Develop 0.4.0a33 locally: add an explicit preserve-existing path for compatible Windows SSH/RustDesk services, pin the existing account SID, host key, config and custom SSH port, and add only GMSSH-owned files/tasks. Preserve service startup, firewall, account and desktop settings during setup, pause and upgrade.
- Keep separate existing SSH/desktop credentials in the protected encrypted store. Reuse independent grants for desktop access, keep the desktop secret off legacy enrollment responses, and label the optional SSH-only sharing path. Update native desktop acceptance documentation; preserved installation and full CLI/MCP device acceptance remain pending.

- Fix native AI screenshot scaling under Windows PowerShell 5.1 by selecting the floating-point `Math.Min` overload. Add a desktop-free regression for 1440p, ultrawide, portrait and small displays; preserve the 1600×1000 image bound.
- Use Windows PowerShell 5.1-compatible `UInt16` casts for native key actions and exercise the actual argument expressions without sending keyboard input.

- Develop 0.4.0a32 locally: enforce independent `files_read` grants at the Windows file API, including raw write/open/remove/rename rejection. Negotiate the additive capability, preserve six-field legacy read/write grants, and distinguish actual server policy from a controller-only read restriction.
- Block new and queued requests promptly when a session closes, a policy changes or a grant is revoked. Keep closing resources counted until asynchronous cleanup finishes; report interrupted/timeout/closed operations without automatically replaying commands or writes. Add an owner read-only preset and readable file-center mode with uploads/creation disabled.

- Develop controller 0.4.0a31 locally: add `files_read` for search/read/preview/hash-wait tools while retaining legacy `files` read/write behavior. Check the same local policy before CLI/MCP connections, and intersect read permission with the current server file channel during access checks.
- Add offline `device_tools` / `gmssh-ai tools DEVICE` to describe the local tool subset and allowed wait conditions without claiming remote readiness. Add a user-operated read-only form preset and clear local-mode labels; permission changes still require saving and never expand server grants.

- Develop controller 0.4.0a30 locally: add bounded literal text search in a specified file, unique-fragment replacement previews/commits and verified creation of new text files over the existing SFTP interfaces. Keep original hashes and backups, preserve BOM/surrounding line endings, stop ambiguous edits and never overwrite a creation target.
- Distinguish an unknown creation commit from failure or success, retaining the intended hash and recovery paths without automatic retry or deleting the destination. Continue to use Windows a27 protocol; no endpoint, real-device or current-app changes.

- Develop controller 0.4.0a29 locally: add bounded task waits and private, restart-safe task receipts without storing command bodies or output. Preserve request keys before submission, separate wait timeout from task failure, retain known remote results if a local receipt write fails, and never replay commands automatically.
- Add a human task-history tab with dated local observations and explicit, permission-checked remote status/output queries. Add hash-checked UTF-8 byte continuation so long single lines can be read completely without skipping or splitting characters. Reuse Windows a27 protocol; no real-device changes or new listener.

- Develop controller 0.4.0a28 locally: add an AI access panel for masked authorization preview, explicit permissions, same-identity credential refresh, local disable, current access checks, optional SDK preparation, stdio self-test and configuration copy. Keep setup actions outside MCP and never read the vendor credential database.
- Add a dated `device_access_check` tool, distinguish effective grants from desktop pause/lock/worker readiness, invalidate old checks after configuration changes, and keep disabled devices off the network. Add local-only `doctor`, user-operated SSH credential refresh and Codex TOML/CLI formats without exporting credential values. Existing Windows a27 protocol remains compatible; no real device operations or application switch.

- Develop 0.4.0a27 locally: add opt-in `gmssh-ai` CLI and official-SDK stdio MCP over shared bounded operations, pinned existing SSH/HTTPS transports, public device metadata and Keychain/environment credential references. Do not read the vendor machine credential database or open another Windows network listener.
- Add environment snapshots, fixed system queries, controller-owned encrypted command jobs with exit codes/pagination/idempotency/cancel/reopen lookup, semantic UIA observations and target-bound actions, condition waits, and bounded text search/read/diff/edit/backup restore.
- Run UIA in a tray-owned interactive user worker over a local ACL-protected named pipe, with stale-target checks, Unicode input, a user pause menu and a provider watchdog. Package the helper/scripts and include them in transactional upgrades. Keep Windows native UI acceptance pending; no A4 operations or Mac application switch in this round.

- Develop controller 0.4.0a26: rank supplied pinned targets as LAN IPv6, LAN IPv4, remote IPv6, remote IPv4. Re-evaluate on each new monitoring/desktop transport, including after controller reopen; keep explicit manual addresses fixed and preserve the mode in configuration backups.
- Replace homepage IP columns with connection scope, address family and latency beneath device names. Keep current and saved addresses with copy actions in details; derive the active Windows route from its authenticated transport.

- Clip long IPv6 addresses inside device list and card bounds, preserve full hover/copy values, and wrap detail addresses independently of their copy icon. Verify the old overflow regression and 64 browser checks, then apply the UI-only fix to the existing Mac test client.

- Develop 0.4.0a25 locally: recognize live local-interface IPv6 prefixes for LAN code enrollment; retain explicit source authorization for off-link clients. Distinguish source denial from invalid credentials in both connection-code protocols.
- Add a Windows IPv6 source-settings dialog that synchronizes protected metadata and owned, program-bound TCP 22/22257 rules, backs up settings, and rolls back partial failures. Keep cross-subnet sources opt-in.
- Automatically probe supplied pinned IPv4/IPv6 addresses without sending credentials, retain an available original route, and preserve an explicitly edited address. Keep native device IDs and manual enrollment.
- Refresh desktop bindings when their backend authorization token changes, preserving unchanged sessions. Accept IPv6-only code enrollment, original-card address migration and automatic desktop recovery after a normal Mac client restart on an existing same-subnet Windows installation; no extra off-link rules or password changes.

- Develop 0.4.0a24 locally: add an administrator-controlled IPv4/IPv6 ping toggle. Manage only two owned ICMP echo-request rules, validate rule identity before changing either, and roll back partial failures. Installation leaves ping unchanged.
- Include every usable IPv4 and IPv6 address in current connection exports, shared connection codes and QR codes. Export public, ULA, temporary and deprecated IPv6 addresses; omit loopback, link-local, multicast, duplicate and tentative addresses. Independent grants use the live address list while retaining the pinned device identity.
- Compact the device workspace toolbar: dark device selector, grouped view controls, separate file/tools/history actions, icon exit controls and a narrow-window layout. Keep existing desktop and terminal sessions mounted while switching views.
- Accept the 0.4.0a24 update on the existing Windows test device through the verified package's update function. Verify owned echo-request rules, IPv4 and three IPv6 ping targets, complete IPv6 exports/QR generation, and IPv6 SSH, file round trip and desktop video; record the graphical installer and external-network limits separately.

- Wait for exclusive access to the connection helper after stopping its task. Real Windows task state can become Ready before the executable image is released; cover that gap with a native file-lock regression before retrying the upgrade.
- Resume a canceled quit on the next event-loop turn after saving file tasks. Verify that normal macOS quit ends the main process and bridge listeners, then a new process restores monitoring and the original desktop with saved credentials.
- Add the 0.4.0a23 source candidate across the accepted four-phase plan. Existing-installation upgrade, restart recovery and distinct-password reconnection have device evidence; broader feature acceptance and a new installer release remain pending.
- Add pinned Linux SFTP with password/private-key authentication and bastion chains to the native, resumable file queue. Keep POSIX path semantics, favorites, folder creation and current-directory refresh.
- Add device workspaces, in-place desktop/terminal split views, per-device display preferences and local metadata-only connection history with retention and export. Restore inactive desktop tabs without opening duplicate sessions.
- Add permanent independent controller grants, QR sharing, per-channel server policy, single-session disconnect and individual revocation. Keep Windows/desktop passwords on the server and preserve legacy shared-password connections.
- Add bounded HTTPS file operations, Windows ConPTY bindings, fixed read-only collectors and genuine Windows terminal lifecycle events. Windows native execution remains a separate acceptance step.

- Develop 0.4.0a22 locally: persist up to 12 favorite remote directories per device in the controller. Display paths and remove only favorite metadata; do not automatically open a stored location or grant local file access.
- Bind favorites to the verified SSH peer. Check that peer before saving or opening, preserve paths on identity/connection failures and ignore an opening result when the user has already navigated elsewhere.
- Keep favorites in a separate private, bounded atomic store. A corrupt favorite record leaves transfers usable; failed writes preserve prior metadata. Refresh the favorite list on demand and negotiate the capability so older controllers retain their existing file tools. Exclude favorites from source exports and device backups.

- Develop 0.4.0a21 locally: add per-device backward/forward directory navigation with a bounded 64-entry in-memory history. Restore search, sort and scroll positions only after successful reads; failed navigation and refreshes do not corrupt the forward branch.
- Create a single folder inside the displayed directory through the existing authenticated file channel. Validate the name and target length, show the exact parent, lock navigation while submitting and distinguish newly created from existing directories.
- Require acknowledgement of the exact creation target, retain input when the result is unconfirmed, preserve same-name files and allow explicit refresh/retry. Reuse existing mkdir support without a Windows service upgrade or new listener.

- Develop 0.4.0a20 locally: search the loaded directory by name, sort naturally or by file size/modification time, refresh explicitly and display modification metadata without inventing missing timestamps. Searches are local to the loaded entries and clearly identify truncated directories.
- Select/deselect only matching visible entries; retain other selections with an explicit hidden-selection count, offer clear selection, and refresh selected metadata without retaining disappeared or changed-kind entries.
- Keep navigation and transfer targets consistent: suspend old-directory transfer controls while reading, retain the previous directory on failure, discard stale replies and reset old selection/search after successful navigation. Keep browsing controls and file rows reachable in short windows.
- Validate bounded directory replies before replacing the last successful listing, including names, duplicates, sizes and timestamps. No new remote operations or listeners are introduced.

- Develop 0.4.0a19 locally: filter file tasks by device, state, filename and path; progressively display the complete native queue in batches of 50 instead of hiding jobs beyond the old summary limits. Preserve search focus and expanded details during polling.
- Show task source, destination, creation time, failure code and verified SHA-256 as local metadata. Provide readable recovery hints and per-task cancellation/partial cleanup in the global view.
- Pause an explicit snapshot of filtered native jobs and clear only selected completed/cancelled records. Validate all IDs and device ownership before mutation, pause queued jobs before releasing the active worker, retain pending-cleanup records and never remove files when clearing records.
- Avoid refreshing a historical task snapshot over an in-flight directory navigation; keep the selected upload destination ready after restoring completed tasks.

- Develop 0.4.0a18 locally: save to mounted external and network volumes without requiring hard links. Prefer native exclusive rename, retain a safe link fallback, and use an exclusive-created, journaled streaming copy when both are unavailable.
- Show the separate save/copy phase; retain owned partials across interruption and verify the existing target prefix before resuming. Compatibility copy can expose an incomplete destination until completion and needs additional free space equal to the file size.
- Normalize 64-bit file IDs between Node and Python, revalidate remounted directories after a fresh system-picker grant, retain conflicting files, and allow a new local filename without downloading the verified part again. Complete local saves without reconnecting the remote Windows host.
- Treat unsupported directory flush separately from file-data failures; report disconnected/read-only volumes, quota and file-size limits. Preserve worker journal acknowledgements before any compatibility-target write.

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
