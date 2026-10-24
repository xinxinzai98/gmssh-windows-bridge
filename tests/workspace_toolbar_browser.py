"""Run after npm run build; requires Playwright and a local Chromium executable.

Uses the built viewer on a second loopback origin, with synthetic config only.
No desktop connection, real device, credentials or native application is used.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def run(output: Path, chromium: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(['node', 'tests/workspace_fixture.js'], cwd=ROOT,
                              stdout=subprocess.PIPE, text=True)
    checks = []
    errors = []

    def check(value, name):
        assert value, name
        checks.append(name)

    try:
        address = json.loads(server.stdout.readline())
        base = address['url']
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(
                (base, address['viewerUrl'])) else route.abort())
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base, wait_until='networkidle')
            page.get_by_role('button', name='运行工作区检查').click()
            page.wait_for_function('window.fixtureResult')
            old = page.evaluate('window.fixtureResult')
            check(not old.get('error') and old['passed'] > 0, 'existing workspace fixture: ' + str(old))
            page.close()
            context.request.post(base + 'workspace', data={'action': 'layout', 'data': {
                'tabs': [], 'selected': None, 'devices': {}}})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("""window.toolbarReadyMessages=[];addEventListener('message',e=>{
                if(e.data?.type==='gmssh-workspace-desktop'&&e.data.toolbarReady)toolbarReadyMessages.push(e.data);
            });""")
            page.goto(base + '?viewer=1', wait_until='networkidle')

            def desktop():
                page.evaluate("c.open(win,'desktop')")
                page.locator('.gm-workspace-desktop-toolbar').wait_for()
                expect(frame.locator('.toolbar')).to_have_class('toolbar workspace-toolbar')

            frame = page.frame_locator('iframe')

            def menu(opened=True):
                if frame.locator('#desktop-menu').evaluate('e=>e.open') != opened:
                    frame.locator('#desktop-menu summary').click()
                if opened:
                    expect(frame.locator('.menu-panel')).to_be_visible()
                else:
                    expect(frame.locator('.menu-panel')).to_be_hidden()

            desktop()
            page.wait_for_function("windows.frame().dataset.ready==='1'")
            page.evaluate('window.originalViewer=windows.frame()')
            expect(page.locator('.gm-workspace-head')).to_be_hidden()
            check(page.evaluate('new URL(windows.frame().src).origin!==location.origin'), 'real viewer uses a different origin')
            expect(frame.get_by_role('combobox', name='切换设备工作区')).to_be_hidden()
            expect(frame.locator('.workspace-device-name')).to_have_text('设计工作站')
            check(frame.locator('.workspace-modes button').count() == 2, 'primary navigation only exposes desktop and terminal')
            frame.locator('#display').evaluate('e=>e.remove(1)')
            expect(frame.locator('[data-desktop-control=display]')).to_be_hidden()
            frame.locator('#display').evaluate("e=>e.add(new Option('显示器 2','1'))")
            expect(frame.locator('[data-desktop-control=display]')).to_be_visible()
            checks.append('single device is a label; monitor selector follows actual monitor count')
            frame.locator('#zoom').evaluate('e=>window.originalZoom=e')
            for width in [1440, 1280, 1180, 1179, 1024, 960, 940, 939, 840, 839, 720, 719, 640, 639, 520, 519, 420, 360]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.wait_for_timeout(60)
                menu(False)
                geometry = frame.locator('.toolbar').evaluate("""e=>{
                    const r=e.getBoundingClientRect(),items=[...e.children].filter(n=>n.getBoundingClientRect().width);
                    return {height:r.height,overflow:e.scrollWidth>e.clientWidth,
                        overlaps:items.some((n,i)=>i&&items[i-1].getBoundingClientRect().right>n.getBoundingClientRect().left+.5)};
                }""")
                check(geometry == {'height': 54, 'overflow': False, 'overlaps': False}, f'{width}px: single row, no overlap or overflow')
                expect(frame.locator('#connection-label')).to_be_visible()
                expect(frame.locator('.tools #files')).to_be_visible()
                if width in [1440, 960, 420]:
                    page.screenshot(path=str(output / f'desktop-{width}.png'))
                menu()
                bounds = frame.locator('.menu-panel').bounding_box()
                check(bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width + 1, f'{width}px: menu stays in the window')
                if width == 420:
                    expect(frame.locator('#files')).to_be_visible()
                    expect(frame.locator('#zoom')).to_be_visible()
                    expect(frame.locator('#keyboard .control-label')).to_be_visible()
                    page.screenshot(path=str(output / 'menu-420.png'))
                menu(False)

            frame.locator('#connection-label').evaluate("e=>{e.textContent='未连接';e.classList.remove('online')}")
            expect(frame.locator('#connection-label')).to_be_visible()
            expect(frame.locator('#connection-label')).to_have_text('未连接')
            frame.locator('#connection-label').evaluate("e=>{e.textContent='已连接（模拟）';e.classList.add('online')}")
            checks.append('connection text and device files remain visible at all tested widths, including disconnected at 360px')

            page.set_viewport_size({'width': 1440, 'height': 900})
            expect(frame.locator('#zoom')).to_be_visible()
            check(frame.locator('#zoom').evaluate('e=>e===window.originalZoom'), 'resize retains the same control nodes')
            frame.locator('#zoom').select_option('100')
            expect(frame.locator('#viewport')).to_have_class('actual-size')
            page.wait_for_function("calls.some(r=>r.action==='layout'&&r.data.devices[win]?.zoom==='100')")
            checks.append('zoom change reaches the viewer and persists to the correct device')
            menu()
            # A repeated parent handshake must not dismiss an open menu.
            page.evaluate("windows.frame().contentWindow.postMessage({type:'gmssh-workspace-toolbar-request'},new URL(windows.frame().src).origin)")
            page.wait_for_timeout(150)
            expect(frame.locator('.menu-panel')).to_be_visible()
            checks.append('toolbar resynchronization preserves the open menu')
            frame.locator('#quality').select_option('best')
            page.wait_for_function("calls.some(r=>r.action==='layout'&&r.data.devices[win]?.quality==='best')")
            frame.locator('#keyboard').click()
            expect(frame.locator('#keyboard-dialog')).to_be_visible()
            frame.locator('#keyboard-dialog [data-close]').click()
            menu()
            frame.locator('#clipboard').click()
            expect(frame.locator('#clipboard-dialog')).to_be_visible()
            check(not frame.locator('#desktop-menu').evaluate('e=>e.open'), 'overflow action closes the menu')
            frame.locator('#clipboard-dialog [data-close]').click()
            menu()
            frame.locator('#power').click()
            expect(frame.locator('#power-dialog')).to_be_visible()
            frame.locator('#power-dialog [data-close]').click()
            checks.append('keyboard, clipboard and power still open their original dialogs')
            frame.locator('#files').click()
            page.wait_for_function("fixtureActions.some(a=>a.tool==='files'&&a.id===win)")
            checks.append('file center routes to the selected device')
            frame.locator('#fullscreen').click()
            expect(frame.locator('#viewport')).to_have_class('actual-size expanded')
            frame.locator('#leave-fullscreen').click()
            expect(frame.locator('#viewport')).to_have_class('actual-size')
            checks.append('expand and restore keep the toolbar and live view')

            # Reject messages from another source/origin, or an obsolete viewer instance.
            for mode in ['origin', 'source', 'instance']:
                page.evaluate("""mode=>dispatchEvent(new MessageEvent('message',{
                    source:mode==='source'?window:windows.frame().contentWindow,
                    origin:mode==='origin'?location.origin:new URL(windows.frame().src).origin,
                    data:{type:'gmssh-workspace-desktop',instance:mode==='instance'?'obsolete':toolbarReadyMessages.at(-1).instance,
                        workspaceAction:'mode',value:'overview'}}))""", mode)
                expect(page.locator('.gm-workspace')).to_have_class('gm-workspace gm-workspace-desktop-toolbar')
                checks.append('ignores mismatched ' + mode)

            menu()
            frame.get_by_role('button', name='设备概览', exact=True).click()
            expect(page.locator('.gm-workspace-body .gm-device-details')).to_be_visible()
            check(page.evaluate('windows.panel.hidden'), 'overview hides the old desktop overlay without closing it')
            # A retained but inactive viewer cannot navigate the foreground workspace.
            page.evaluate("""()=>dispatchEvent(new MessageEvent('message',{source:windows.frame().contentWindow,
                origin:new URL(windows.frame().src).origin,data:{type:'gmssh-workspace-desktop',
                instance:toolbarReadyMessages.at(-1).instance,workspaceAction:'mode',value:'desktop'}}))""")
            expect(page.locator('.gm-workspace-body .gm-device-details')).to_be_visible()
            checks.append('inactive viewers cannot navigate the foreground workspace')
            desktop()
            menu()
            frame.get_by_role('button', name='桌面与终端分屏', exact=True).click()
            expect(page.locator('.gm-workspace-head')).to_be_visible()
            expect(frame.locator('.workspace-leading')).to_be_hidden()
            expect(frame.locator('.tools #clipboard')).to_be_visible()
            check(page.evaluate('windows.frame()===originalViewer&&creates===1'), 'split restores the original toolbar without recreating the viewer')
            desktop()
            menu()
            frame.get_by_role('button', name='系统工具', exact=True).click()
            page.wait_for_function("fixtureActions.some(a=>a.tool==='tools'&&a.id===win)")
            menu()
            frame.get_by_role('button', name='连接记录', exact=True).click()
            expect(page.locator('.gm-workspace-history')).to_be_visible()
            desktop()
            check(page.evaluate('windows.frame()===originalViewer&&creates===1'), 'history and tools preserve the desktop session')

            page.evaluate("""()=>{window.originalDevices=gmsshHomeController.filesDevices;
                gmsshHomeController.filesDevices=()=>originalDevices().map(d=>d.id===win?{...d,permissions:{view:true,terminal:false,files:false,input:false,clipboard:false,power:false}}:d);}
            """)
            desktop()
            expect(frame.locator('.workspace-modes').get_by_role('button', name='终端', exact=True)).to_be_disabled()
            menu()
            expect(frame.get_by_role('button', name='桌面与终端分屏', exact=True)).to_be_disabled()
            menu(False)
            page.evaluate("""()=>dispatchEvent(new MessageEvent('message',{source:windows.frame().contentWindow,
                origin:new URL(windows.frame().src).origin,data:{type:'gmssh-workspace-desktop',
                instance:toolbarReadyMessages.at(-1).instance,workspaceAction:'mode',value:'terminal'}}))""")
            expect(page.locator('.gm-workspace')).to_have_class('gm-workspace gm-workspace-desktop-toolbar')
            checks.append('restricted terminal permission is enforced in controls and host routing')
            page.evaluate('gmsshHomeController.filesDevices=originalDevices')
            page.evaluate("c.open(linux,'terminal')")
            desktop()
            frame.get_by_role('combobox', name='切换设备工作区').select_option('b' * 32)
            expect(page.locator('.gm-workspace-head select')).to_have_value('b' * 32)
            check(page.evaluate('windows.panel.hidden'), 'device selector switches to the exact saved device')
            desktop()
            menu()
            frame.get_by_role('button', name='返回首页', exact=True).click()
            expect(page.locator('.gm-workspace')).to_be_hidden()
            desktop()
            menu()
            frame.get_by_role('button', name='关闭工作区视图', exact=True).click()
            expect(page.locator('.gm-workspace')).to_be_hidden()
            check(page.evaluate('windows.frame()===originalViewer&&creates===1'), 'home and close-workspace do not destroy the desktop session')
            desktop()
            old_instance = page.evaluate('toolbarReadyMessages.at(-1).instance')
            frame.locator('body').evaluate('()=>location.reload()')
            page.wait_for_function('old=>toolbarReadyMessages.at(-1).instance!==old', arg=old_instance)
            expect(frame.locator('.toolbar')).to_have_class('toolbar workspace-toolbar')
            check(page.evaluate('windows.frame()===originalViewer&&creates===1'), 'reloaded viewer negotiates the merged toolbar again')
            frame.locator('#zoom').select_option('fit')
            page.screenshot(path=str(output / 'desktop-1440.png'))
            page.screenshot(path=str(output / 'toolbar-1440.png'), clip={'x': 0, 'y': 48, 'width': 1440, 'height': 160})
            menu()
            page.screenshot(path=str(output / 'menu-1440.png'))
            page.set_viewport_size({'width': 420, 'height': 400})
            frame.get_by_role('button', name='关闭工作区视图', exact=True).scroll_into_view_if_needed()
            bounds = frame.get_by_role('button', name='关闭工作区视图', exact=True).bounding_box()
            check(0 <= bounds['y'] and bounds['y'] + bounds['height'] <= 400, 'short windows can scroll to the final menu action')
            standalone = context.new_page()
            standalone.on('pageerror', lambda error: errors.append(str(error)))
            standalone.goto(address['viewerUrl'], wait_until='networkidle')
            expect(standalone.locator('.toolbar')).to_have_class('toolbar')
            expect(standalone.locator('.tools #clipboard')).to_be_visible()
            check(standalone.locator('.workspace-leading').count() == 0, 'standalone viewer retains its original controls')
            standalone.close()
            check(not errors, 'no browser JavaScript errors: ' + str(errors))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
        (output / 'report.json').write_text(json.dumps({'checks': checks, 'page_errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': len(checks), 'output': str(output)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--chromium', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.chromium:
        parser.error('Install Chromium or pass --chromium; this check does not install a browser.')
    run(args.output.resolve(), args.chromium)
