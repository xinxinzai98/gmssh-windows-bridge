// Keep desktop controls in their own viewer: moving these DOM nodes preserves
// their handlers, permission state and transfer badges across workspace changes.
export function installWorkspaceToolbar(instance: string, send: (value: Record<string, unknown>) => void): void {
  if (window.parent === window) return;
  const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
  const menu = document.querySelector<HTMLDetailsElement>('#desktop-menu')!;
  const menuPanel = menu.querySelector<HTMLElement>('.menu-panel')!;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => {
    const node = document.createElement(tag); node.className = className; return node;
  };
  let active = false;
  const request = (action: string, value?: string) => {
    if (!active) return;
    menu.open = false;
    send({ workspaceAction: action, ...(value ? { value } : {}) });
  };
  const button = (label: string, icon: string, action: () => void) => {
    const node = make('button'); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    const image = make('img'); image.src = '/ui-icons/' + icon + '.svg'; image.alt = '';
    const text = make('span', 'control-label'); text.textContent = label;
    node.append(image, text); node.onclick = action; return node;
  };
  const device = make('label', 'workspace-device');
  const deviceIcon = make('img'); deviceIcon.src = '/ui-icons/windows.svg'; deviceIcon.alt = '';
  const selector = make('select'); selector.setAttribute('aria-label', '切换设备工作区');
  selector.onchange = () => request('device', selector.value);
  const deviceName = make('span', 'workspace-device-name');
  device.append(deviceIcon, selector, deviceName);
  const navigation = make('nav', 'workspace-modes'); navigation.setAttribute('aria-label', '工作区视图');
  const compactMode = make('select', 'workspace-mode-select'); compactMode.setAttribute('aria-label', '工作区视图');
  compactMode.onchange = () => request('mode', compactMode.value);
  const modes = new Map<string, { button: HTMLButtonElement; option?: HTMLOptionElement }>();
  for (const [key, label, icon] of [['desktop', '桌面', 'monitor'], ['terminal', '终端', 'terminal-window']]) {
    const control = button(label, icon, () => request('mode', key));
    control.setAttribute('aria-pressed', String(key === 'desktop'));
    const option = make('option'); option.value = key; option.textContent = label;
    navigation.append(control); compactMode.append(option); modes.set(key, { button: control, option });
  }
  compactMode.value = 'desktop';
  const leading = make('div', 'workspace-leading'); leading.hidden = true; leading.append(device, navigation, compactMode);
  toolbar.prepend(leading);
  const overflow = make('div', 'workspace-overflow'); overflow.hidden = true;
  overflow.addEventListener('click', event => { if ((event.target as Element).closest('button:not(:disabled)')) menu.open = false; });
  const workspaceActions = make('div', 'workspace-menu-actions'); workspaceActions.hidden = true;
  for (const [key, label, icon] of [['overview', '设备概览', 'grid-four'], ['split', '桌面与终端分屏', 'list']]) {
    const control = button(label, icon, () => request('mode', key));
    workspaceActions.append(control); modes.set(key, { button: control });
  }
  workspaceActions.append(button('系统工具', 'gear', () => request('tools')), button('连接记录', 'arrows-clockwise', () => request('history')));
  const exits = make('div', 'workspace-menu-exits'); exits.hidden = true;
  exits.append(button('返回首页', 'arrow-left', () => request('home')), button('关闭工作区视图', 'x', () => request('close')));
  exits.lastElementChild!.setAttribute('title', '关闭工作区视图；保留已打开的连接');
  menuPanel.prepend(overflow, workspaceActions);
  menuPanel.append(exits);
  const display = document.getElementById('display') as HTMLSelectElement;
  const controls = ['display', 'zoom', 'quality', 'keyboard', 'clipboard', 'files', 'power', 'fullscreen'].map(id => {
    const control = document.getElementById(id)!;
    const node = control.tagName === 'SELECT' ? control.parentElement! : control;
    const marker = document.createComment('toolbar-' + id); node.before(marker);
    node.dataset.desktopControl = id;
    return { id, node, marker };
  });
  function arrange(): void {
    let menuIndex = 0;
    for (const { id, node, marker } of controls) {
      node.hidden = active && id === 'display' && display.options.length < 2;
      const inMenu = active && (['quality', 'keyboard', 'clipboard', 'power'].includes(id) ||
        (innerWidth < 1180 && id === 'display') ||
        (innerWidth < 520 && id === 'zoom'));
      if (inMenu) { if (overflow.children[menuIndex] !== node) overflow.insertBefore(node, overflow.children[menuIndex] || null); menuIndex++; }
      else if (node.previousSibling !== marker) marker.after(node);
    }
  }
  // Display enumeration can change after connecting or when a monitor is unplugged.
  new MutationObserver(arrange).observe(display, { childList: true, subtree: true });
  window.addEventListener('resize', arrange);
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source === window.parent && data?.type === 'gmssh-workspace-toolbar-request') { send({ toolbarReady: true }); return; }
    if (event.source !== window.parent || data?.type !== 'gmssh-workspace-toolbar' || data.instance !== instance || typeof data.active !== 'boolean') return;
    if (data.active) {
      if (!Array.isArray(data.devices) || data.devices.length > 50 ||
          !data.devices.every((d: { id?: unknown; name?: unknown }) => d && typeof d.id === 'string' && /^[a-f0-9]{32}$/i.test(d.id) && typeof d.name === 'string' && d.name.length <= 200) ||
          !data.devices.some((d: { id: string }) => d.id === data.selected)) return;
      selector.replaceChildren(...data.devices.map((d: { id: string; name: string }) => {
        const option = make('option'); option.value = d.id; option.textContent = d.name; return option;
      }));
      selector.value = data.selected; selector.title = selector.selectedOptions[0].textContent || '';
      deviceName.textContent = selector.title; deviceName.title = selector.title;
      selector.hidden = data.devices.length === 1; deviceName.hidden = !selector.hidden;
      device.classList.toggle('single-device', selector.hidden);
      for (const [key, control] of modes) {
        const disabled = ['terminal', 'split'].includes(key) && data.terminal === false;
        control.button.disabled = disabled;
        if (control.option) control.option.disabled = disabled;
      }
      compactMode.value = 'desktop';
    }
    if (active !== data.active) menu.open = false;
    active = data.active;
    toolbar.classList.toggle('workspace-toolbar', active);
    document.body.classList.toggle('has-workspace-toolbar', active);
    leading.hidden = exits.hidden = overflow.hidden = workspaceActions.hidden = !active;
    arrange();
  });
  send({ toolbarReady: true });
}
