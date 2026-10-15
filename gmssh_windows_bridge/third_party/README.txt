GMSSH Windows includes the unmodified native files from the official RustDesk 1.5.0 portable release as an internal desktop engine.
Upstream release: https://github.com/rustdesk/rustdesk/releases/tag/1.5.0
Corresponding upstream source and build instructions: https://github.com/rustdesk/rustdesk/tree/1.5.0 (including the referenced Git submodules).
The original RustDesk AGPL-3.0 licence accompanies this package. The upstream payload also retains its Flutter NOTICES.Z and driver licence files.
GMSSH's installer and tray scripts are separate orchestration code. No RustDesk executable or library is patched or rebranded.
OpenSSH's official, unchanged Microsoft MSI is included from https://github.com/PowerShell/Win32-OpenSSH/releases/tag/10.0.0.0p2-Preview.
Public friend-test bundles do not include Microsoft Visual C++ Redistributable. When the required runtime is absent or too old, setup obtains the pinned installer directly from Microsoft, verifies SHA-256 and Authenticode, and installs it. Microsoft's terms apply: https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist . Private offline builds may still include an unchanged redistributable only when the builder has the required redistribution rights.
