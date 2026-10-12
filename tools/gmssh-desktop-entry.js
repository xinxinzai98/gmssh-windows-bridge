/* Temporary GMSSH page integration; call with the exact Windows machine ID.
 * Restoring the page removes the hook. No vendor files or account data change.
 */
window.installWindowsDesktopEntry = function ({ machineId, viewerUrl }) {
  const url = new URL(viewerUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || typeof machineId !== "string" || !machineId) {
    throw new Error("Use a loopback viewer URL and an exact machine ID");
  }
  const machine = [...document.querySelectorAll('[data-machine-id]')]
    .find(element => element.getAttribute("data-machine-id") === machineId);
  if (!machine?.querySelector('[data-machine-action="desktop"]')) {
    throw new Error("Open the machine list containing the selected Windows desktop button");
  }
  window.removeWindowsDesktopEntry?.();
  let panel;
  function open() {
    if (panel) return;
    panel = document.createElement("section");
    panel.setAttribute("aria-label", "Windows RustDesk desktop");
    Object.assign(panel.style, { position: "fixed", inset: "48px 12px 12px", zIndex: "2147483000",
      display: "flex", flexDirection: "column", background: "#13181f", border: "1px solid #53637b", borderRadius: "8px" });
    const bar = document.createElement("header");
    Object.assign(bar.style, { display: "flex", alignItems: "center", padding: "8px 14px", color: "#e9edf3" });
    const title = document.createElement("span");
    title.textContent = "Windows 桌面 · RustDesk";
    title.style.flex = "1";
    const close = document.createElement("button");
    close.textContent = "关闭桌面";
    close.addEventListener("click", () => { panel.remove(); panel = undefined; });
    const frame = document.createElement("iframe");
    frame.title = "Windows RustDesk 查看器";
    frame.src = url.href;
    frame.allow = "fullscreen";
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { flex: "1", minHeight: "0", border: "0", width: "100%" });
    bar.append(title, close); panel.append(bar, frame); document.body.append(panel);
  }
  function click(event) {
    const target = event.target instanceof Element ? event.target : undefined;
    const button = target?.closest('[data-machine-action="desktop"]');
    if (button?.closest('[data-machine-id]')?.getAttribute("data-machine-id") !== machineId) return;
    event.preventDefault(); event.stopImmediatePropagation(); open();
  }
  document.addEventListener("click", click, true);
  window.removeWindowsDesktopEntry = () => {
    document.removeEventListener("click", click, true);
    panel?.remove(); panel = undefined;
  };
  return { open, remove: window.removeWindowsDesktopEntry };
};
