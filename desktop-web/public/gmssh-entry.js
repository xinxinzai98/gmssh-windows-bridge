/* GMSSH 2.0.4 page integration; no account records or vendor files change. */
window.installWindowsDesktopEntry = function ({ machineId, viewerUrl, label = "Windows 桌面", card, autoConnect = false, preserveSession = false, accessToken, managed = false }) {
  const url = new URL(viewerUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      (machineId !== undefined && (typeof machineId !== "string" || !machineId)) || (!machineId && !card)) {
    throw new Error("Use a loopback viewer URL and an exact machine ID");
  }
  if (accessToken !== undefined && (typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(accessToken))) {
    throw new Error("Invalid desktop session token");
  }
  if (card && (!card.host || !card.name || typeof card.host !== "string" || typeof card.name !== "string")) {
    throw new Error("A desktop-only card requires the configured device name and address");
  }
  // Exact IDs route the native blue button; other machines retain their handler.
  const boundId = machineId || "windows-desktop:" + card.host;
  const windowsIcon = new URL('ui-icons/windows.svg', url).href;
  const nativeIcons = new Map();
  let retained;
  if (preserveSession) {
    const existing = document.querySelector('#gmssh-windows-panel, section[aria-label="Windows RustDesk desktop"]');
    const frame = existing?.querySelector("iframe");
    if (frame && new URL(frame.src).origin === url.origin && new URL(frame.src).pathname === url.pathname) retained = existing;
  }
  if (retained) {
    // Dispose the previous controller without detaching its authenticated iframe.
    const remove = retained.remove;
    retained.remove = () => {};
    try { window.removeWindowsDesktopEntry?.(); } finally { retained.remove = remove; }
    retained.querySelector(":scope > header")?.remove();
    retained.style.display = "";
  } else if (!managed) window.removeWindowsDesktopEntry?.();
  if (autoConnect) url.searchParams.set("autoconnect", "1");
  let panel = retained, tab, desktopCard;
  const slot = (managed && (window.gmsshWindowsTabSlot || document.querySelector('.gmssh-windows-tabs'))) || document.createElement("div");
  if (managed) window.gmsshWindowsTabSlot = slot;
  slot.className = "gmssh-windows-tabs no-drag";
  slot.setAttribute("role", "tablist");
  slot.setAttribute("aria-label", "Windows 桌面标签");
  const style = (managed && document.getElementById('gmssh-windows-entry-style')) || document.createElement("style");
  if (managed) style.id = 'gmssh-windows-entry-style';
  style.textContent = [
    ".gmssh-windows-tabs { display:flex; flex:0 1 auto; gap:6px; max-width:45%; min-width:0; overflow-x:auto; scrollbar-width:thin; -webkit-app-region:no-drag; }",
    ".gmssh-windows-tab { display:flex; flex:0 0 auto; align-items:center; height:34px; max-width:240px; border-radius:8px; background:transparent; color:#ffffffa6; overflow:hidden; }",
    ".gmssh-windows-tab.active { background:#ffffff26; color:#fff; }",
    ".gmssh-windows-tab:hover { background:#ffffff1f; }",
    ".gmssh-windows-tab button { font:14px system-ui,sans-serif; color:inherit; border:0; background:transparent; cursor:pointer; -webkit-app-region:no-drag; }",
    ".gmssh-windows-tab [role=tab] { padding:0 8px 0 10px; height:34px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
    ".gmssh-windows-tab [role=tab] { display:flex; align-items:center; gap:8px; }",
    ".gmssh-windows-tab [role=tab] img { width:18px; height:18px; }",
    ".gmssh-windows-tab .close { flex:0 0 22px; width:22px; height:22px; margin-right:6px; padding:0; border-radius:50%; font-size:18px; }",
    ".gmssh-windows-tab .close:hover { background:#ffffff26; }",
    ".gmssh-windows-tab button:focus-visible { outline:2px solid #80b5ed; outline-offset:-2px; }",
    "html[data-windows-desktop-active] .tabs-container .tab-chip--active { background:transparent!important; color:#ffffffa6!important; }",
    ".gmssh-windows-card { padding:16px; min-width:0; border-radius:8px; background:#ffffff0a; color:#ffffffd9; }",
    ".gmssh-windows-card[hidden] { display:none!important; }",
    ".gmssh-windows-card .windows-card-badge { font:12px system-ui; color:#94b9ed; margin-bottom:12px; }",
    ".gmssh-windows-card .windows-card-main { display:flex; align-items:center; gap:12px; }",
    ".gmssh-windows-card .windows-card-icon { width:44px; height:44px; border-radius:10px; object-fit:contain; }",
    ".gmssh-windows-card .windows-card-details { flex:1; min-width:0; }",
    ".gmssh-windows-card .windows-card-name { font:600 16px system-ui; margin-bottom:7px; }",
    ".gmssh-windows-card .windows-card-host { font:14px system-ui; color:#ffffffa6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".gmssh-windows-card .windows-card-note { margin-top:16px; font:12px system-ui; color:#ffffff80; }",
    ".gmssh-windows-card.windows-card-row { margin:8px 0; }"
  ].join("\n");
  document.head.append(style);

  function restoreIcon(image, original) {
    if (image.src !== windowsIcon) return;
    for (const key of ['src','alt']) {
      if (original[key] === null) image.removeAttribute(key); else image.setAttribute(key, original[key]);
    }
  }
  function mountTab() {
    if (!slot.isConnected) {
      const home = document.querySelector(".tabs-container > .tabs-home");
      if (home) home.after(slot);
    }
    mountCard();
    for (const [image, original] of nativeIcons) {
      if (image.isConnected && image.closest('[data-machine-id]')?.dataset.machineId === boundId) continue;
      restoreIcon(image, original); nativeIcons.delete(image);
    }
    for (const node of document.querySelectorAll('[data-machine-id]')) {
      if (node.dataset.machineId !== boundId) continue;
      for (const image of node.querySelectorAll('img.machine-icon-img')) {
        if (!nativeIcons.has(image)) nativeIcons.set(image, {src:image.getAttribute('src'), alt:image.getAttribute('alt')});
        if (image.src !== windowsIcon) image.src = windowsIcon;
        if (image.alt !== 'Windows') image.alt = 'Windows';
      }
    }
  }

  function mountCard() {
    if (machineId || !card) return;
    const template = document.querySelector('[data-machine-id]:not([data-windows-desktop-card]) [data-machine-action="desktop"]');
    const grid = document.querySelector(".machine-card-scroll .grid");
    const list = document.querySelector(".list-item-group[data-machine-id]")?.parentElement;
    const parent = grid || list;
    if (!parent || (!desktopCard && !template)) return;
    if (!desktopCard) {
      desktopCard = document.createElement("article");
      desktopCard.className = "gmssh-windows-card";
      desktopCard.setAttribute("data-machine-id", boundId);
      desktopCard.setAttribute("data-windows-desktop-card", "");
      desktopCard.setAttribute("aria-label", label);
      const text = (className, value) => {
        const node = document.createElement("div"); node.className = className; node.textContent = value; return node;
      };
      const main = document.createElement("div"); main.className = "windows-card-main";
      const details = document.createElement("div"); details.className = "windows-card-details";
      details.append(text("windows-card-name", label), text("windows-card-host", card.host + " · " + card.name));
      // Keep the native blue desktop icon and its action marker, including scoped CSS.
      const button = template.cloneNode(true);
      button.className = "machine-operate-btn machine-operate-btn-gm";
      button.type = "button"; button.removeAttribute("disabled");
      button.querySelector("i").className = "iconfont icon-a-GMmianxing";
      button.title = "进入 Windows 桌面模式";
      button.setAttribute("aria-label", "进入 " + label);
      const actions = template.closest(".machine-operate")?.cloneNode(false) || document.createElement("div");
      actions.classList.add("machine-operate");
      actions.append(button);
      const brand = document.createElement('img'); brand.className = 'windows-card-icon';
      brand.src = windowsIcon; brand.alt = 'Windows';
      main.append(brand, details, actions);
      desktopCard.append(text("windows-card-badge", "Windows · 桌面连接"), main,
        text("windows-card-note", "桌面已配置 · 暂未接入监控"));
    }
    desktopCard.classList.toggle("windows-card-row", !grid);
    if (desktopCard.parentElement !== parent) parent.prepend(desktopCard);
    const search = document.querySelector('input[placeholder="搜索机器名称、IP或备注"]');
    const keyword = search?.value.trim().toLowerCase() || "";
    desktopCard.hidden = !!keyword && !`${label} ${card.host} ${card.name}`.toLowerCase().includes(keyword);
  }
  // The native header may mount after did-finish-load or be recreated by Vue.
  const observer = new MutationObserver(mountTab);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','data-machine-id'] });
  mountTab();

  function hide() {
    if (!panel) return;
    panel.hidden = true;
    tab.classList.remove("active");
    tab.querySelector('[role="tab"]').setAttribute("aria-selected", "false");
    document.documentElement.removeAttribute("data-windows-desktop-active");
  }
  function close() {
    const active = panel && !panel.hidden;
    panel?.remove(); panel = undefined;
    tab?.remove(); tab = undefined;
    if (active) { document.documentElement.removeAttribute("data-windows-desktop-active"); document.querySelector(".tab-chip--home")?.click(); }
  }
  function open() {
    if (managed) for (const controller of window.gmsshWindowsControllers?.values() || []) controller.hide();
    if (!panel) {
      panel = document.createElement("section");
      const frame = document.createElement("iframe");
      frame.title = label + " · RustDesk 查看器";
      frame.src = url.href;
      frame.allow = "fullscreen; clipboard-read; clipboard-write";
      frame.referrerPolicy = "no-referrer";
      panel.append(frame);
      document.body.append(panel);
    }
    panel.id = managed ? "gmssh-windows-panel-" + boundId : "gmssh-windows-panel";
    panel.dataset.windowsMachine = boundId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-label", label);
    panel.querySelector("iframe").title = label + " · RustDesk 查看器";
    if (accessToken) {
      const frame = panel.querySelector("iframe");
      frame.onload = () => {
        const send=auth=>frame.contentWindow?.postMessage({type:'gmssh-desktop-access',token:accessToken,...(auth||{})},url.origin);
        if(managed&&window.electronAPI?.invoke)window.electronAPI.invoke('render-to-main',{type:'gmssh-pair-desktop-auth',data:{machineId:boundId}}).then(reply=>send(reply?.status==='ok'?reply.data:null)).catch(()=>send());
        else send();
      };
    }
    Object.assign(panel.style, { position: "fixed", inset: "48px 0 0", zIndex: "2147483000", background: "#13181f", border: "0", borderRadius: "0" });
    Object.assign(panel.querySelector("iframe").style, { display: "block", height: "100%", width: "100%", border: "0" });
    if (!tab) {
      tab = document.createElement("div");
      tab.className = "gmssh-windows-tab";
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = label;
      const icon = document.createElement('img'); icon.src = windowsIcon; icon.alt = ''; select.prepend(icon);
      select.setAttribute("role", "tab");
      select.setAttribute("aria-controls", panel.id);
      select.addEventListener("click", open);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "close";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "关闭 " + label);
      remove.title = "关闭桌面并断开连接";
      remove.addEventListener("click", close);
      tab.append(select, remove);
      slot.append(tab);
    }
    panel.hidden = false;
    tab.classList.add("active");
    tab.querySelector('[role="tab"]').setAttribute("aria-selected", "true");
    document.documentElement.setAttribute("data-windows-desktop-active", "");
    mountTab();
  }
  function click(event) {
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest(".tabs-container .tab-chip") && !target.closest(".tab-chip__close")) {
      hide(); // Let the native Home/terminal/desktop tab handle its own action.
      return;
    }
    const button = target?.closest('[data-machine-action="desktop"]');
    if (button?.closest('[data-machine-id]')?.getAttribute("data-machine-id") !== boundId) return;
    event.preventDefault(); event.stopImmediatePropagation(); open();
  }
  document.addEventListener("click", click, true);
  document.addEventListener("input", mountCard);
  const remove = () => {
    document.removeEventListener("click", click, true);
    document.removeEventListener("input", mountCard);
    observer.disconnect();
    for (const [image, original] of nativeIcons) restoreIcon(image, original);
    if (panel && !panel.hidden) document.documentElement.removeAttribute("data-windows-desktop-active");
    panel?.remove(); panel = undefined;
    tab?.remove(); desktopCard?.remove();
    if (!managed) { slot.remove(); style.remove(); }
  };
  if (!managed) window.removeWindowsDesktopEntry = remove;
  return { open, hide, close, remove, frame:()=>panel?.querySelector('iframe') };
};

window.installWindowsDesktopEntries = function (devices) {
  const controllers = window.gmsshWindowsControllers ||= new Map();
  const wanted = new Set(devices.map(value=>value.machineId || 'windows-desktop:' + value.card?.host));
  for (const [id, controller] of controllers) if (!wanted.has(id)) { controller.remove(); controllers.delete(id); }
  for (const device of devices) {
    const id=device.machineId || 'windows-desktop:' + device.card?.host;
    if (!controllers.has(id)) controllers.set(id,window.installWindowsDesktopEntry({...device,managed:true}));
  }
  window.removeWindowsDesktopEntry = () => {
    for (const controller of controllers.values()) controller.remove();
    controllers.clear(); window.gmsshWindowsTabSlot?.remove(); delete window.gmsshWindowsTabSlot; document.getElementById('gmssh-windows-entry-style')?.remove();
  };
};
