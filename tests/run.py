#!/usr/bin/env python3
"""Integration checks against a real Zen binary, using a disposable profile."""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from marionette import Client
from launchers import check_launch_cleanup
from protocol_dispatch import check_protocol_dispatch
from tab_context_move import check_tab_context_move

ROOT = Path(__file__).resolve().parents[1]

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><title>Live transfer fixture</title><input id="draft"><div style="height:4000px">Test page</div>'
        if self.path == '/launcher-with-frame':
            body += b'<iframe src="/frame"></iframe>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

def wait_until(callback, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if result := callback():
            return result
        time.sleep(.1)
    raise TimeoutError('Browser condition did not become ready')

def run(client, url, screenshot):
    c = client
    def js(script):
        return c.js(script)['value']
    def ajs(script):
        return c.call('WebDriver:ExecuteAsyncScript', {'script':script,'args':[], 'newSandbox':False,'sandbox':'default'})['value']
    wait_until(lambda: js('return window.gZenStartup?.isReady;'))
    main = c.call('WebDriver:GetWindowHandle')['value']
    setup = ajs('''const done=arguments[arguments.length-1];(async()=>{
      window.testIdentity=ContextualIdentityService.create("Transfer fixture","fingerprint","blue");
      window.sourceSpace=await gZenWorkspaces.createAndSaveWorkspace("Live source",undefined,false,testIdentity.userContextId);
      window.targetSpace=await gZenWorkspaces.createAndSaveWorkspace("Live destination",undefined,true,0);
      for(const r of gZenSpaceRoutingManager.getAllRoutes())gZenSpaceRoutingManager.removeRoute(r.id);
      const r=gZenSpaceRoutingManager.createNewRoute();Object.assign(r,{reference:"127.0.0.1",matchType:"contains",openIn:sourceSpace.uuid});gZenSpaceRoutingManager.updateRoute(r);
      window.mainTabsBefore=gBrowser.tabs.length;
      window.testLittle=LittleZen.openLittleWindow(window,{url:''' + json.dumps(url) + ''',source:"integration-test"});
      done({source:sourceSpace.uuid,target:targetSpace.uuid,container:testIdentity.userContextId});
    })().catch(e=>done({error:String(e)}));''')
    assert 'error' not in setup, setup
    wait_until(lambda: js('return testLittle.gBrowser?.selectedBrowser?.contentTitle === "Live transfer fixture" && !testLittle.document.documentElement.hasAttribute("zen-little-window-loading");'))
    state = js('''const w=testLittle;return {space:w.gZenWorkspaces.activeWorkspace,tabSpace:w.gBrowser.selectedTab.getAttribute("zen-workspace-id"),container:w.gBrowser.selectedTab.userContextId,mainTabs:gBrowser.tabs.length,mainTabsBefore,sidebar:w.getComputedStyle(w.document.getElementById("navigator-toolbox")).display};''')
    assert state['space'] == state['tabSpace'] == setup['source'], state
    assert state['container'] == setup['container'] and state['sidebar'] == 'none', state
    assert state['mainTabs'] == state['mainTabsBefore'], state
    # Toolbar hover must not displace the page.
    hover = js('''const w=testLittle;w.document.getElementById("tabbrowser-tabpanels").setAttribute("has-toolbar-hovered","true");return w.getComputedStyle(w.document.querySelector(".browserContainer")).marginTop;''')
    assert hover == '0px', hover
    # Mouse highlighting, typed filtering, Escape, and keyboard selection.
    js('''const w=testLittle;w.document.getElementById("zen-little-window-space-picker-arrow").dispatchEvent(new w.MouseEvent("mousedown",{bubbles:true}));''')
    menu = js('''const w=testLittle,p=w.document.getElementById("zen-little-window-space-menu"),input=p.querySelector("input");input.value="Live destination";input.dispatchEvent(new w.Event("input",{bubbles:true}));const row=[...p.querySelectorAll("menuitem")].find(i=>!i.hidden);row.dispatchEvent(new w.Event("DOMMenuItemActive"));return {ignorekeys:p.getAttribute("ignorekeys"),label:input.getAttribute("aria-label"),visible:[...p.querySelectorAll("menuitem")].filter(i=>!i.hidden).length,highlight:row.getAttribute("selected")};''')
    assert menu == {'ignorekeys':'true','label':'Search spaces','visible':1,'highlight':'true'}, menu
    js('''const w=testLittle;w.document.querySelector("#zen-little-window-space-menu input").dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));''')
    wait_until(lambda: js('return testLittle.document.getElementById("zen-little-window-space-menu").state === "closed";'))
    # Write state that can only survive if the document remains alive.
    little = None
    for handle in c.call('WebDriver:GetWindowHandles'):
        c.call('WebDriver:SwitchToWindow', {'handle':handle})
        if js('return document.documentElement.hasAttribute("zen-little-window");'):
            little = handle
            break
    assert little is not None, 'Marionette did not expose the Little Zen tab'
    if screenshot:
        data = c.call('WebDriver:TakeScreenshot', {'id':None,'highlights':[],'full':False})
        if isinstance(data, dict): data=data['value']
        Path(screenshot).write_bytes(base64.b64decode(data))
    c.call('Marionette:SetContext', {'value':'content'})
    before = js('''window.liveTransferToken="preserve-live-document";document.getElementById("draft").value="unsaved draft";history.pushState({draft:42},"","#edited");document.cookie="live_transfer_marker=present;path=/";scrollTo(0,500);return {token:liveTransferToken,draft:document.getElementById("draft").value,timeOrigin:performance.timeOrigin,history:history.length,state:history.state,scroll:scrollY,cookie:document.cookie,url:location.href};''')
    c.call('Marionette:SetContext', {'value':'chrome'})
    c.call('WebDriver:SwitchToWindow', {'handle':main})
    for mode in ['throw','null']:
        stub = 'function(){throw new Error("simulated adoption failure");}' if mode == 'throw' else 'function(){return null;}'
        js('window.originalAdopt=gBrowser.adoptTab;gBrowser.adoptTab='+stub+';testLittle.document.getElementById("zen-little-window-space-picker-open").click();')
        time.sleep(.3)
        result = js('gBrowser.adoptTab=originalAdopt;return {closed:testLittle.closed,pending:!!testLittle.__littleZenTransferInProgress};')
        assert result == {'closed':False,'pending':False}, result
    js('''const w=testLittle;w.document.getElementById("zen-little-window-space-picker-arrow").dispatchEvent(new w.MouseEvent("mousedown",{bubbles:true}));const input=w.document.querySelector("#zen-little-window-space-menu input");input.value="Live destination";input.dispatchEvent(new w.Event("input",{bubbles:true}));input.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));window.sourceContext=w.gBrowser.selectedBrowser.browsingContext.id;''')
    assert js('return testLittle.document.getElementById("zen-little-window-space-picker-open").getAttribute("label");') == 'Open in Live destination'
    js('testLittle.document.getElementById("zen-little-window-space-picker-open").click();')
    wait_until(lambda: js('return testLittle.closed;'))
    adopted = js('return {workspace:gZenWorkspaces.activeWorkspace,tabWorkspace:gBrowser.selectedTab.getAttribute("zen-workspace-id"),context:gBrowser.selectedBrowser.browsingContext.id,sourceContext,container:gBrowser.selectedTab.userContextId};')
    assert adopted['workspace'] == adopted['tabWorkspace'] == setup['target'], adopted
    assert adopted['context'] == adopted['sourceContext'] and adopted['container'] == setup['container'], adopted
    c.call('WebDriver:SwitchToWindow', {'handle':main})
    c.call('Marionette:SetContext', {'value':'content'})
    after = js('return {token:window.liveTransferToken,draft:document.getElementById("draft")?.value,timeOrigin:performance.timeOrigin,history:history.length,state:history.state,scroll:scrollY,cookie:document.cookie,url:location.href};')
    assert before == after, {'before':before,'after':after}
    c.call('Marionette:SetContext', {'value':'chrome'})
    # A null browser placeholder must not break close; real unload refusal still applies.
    js('window.testLittle=LittleZen.openLittleWindow(window,{url:'+json.dumps(url)+',source:"close-test"});')
    wait_until(lambda: js('return testLittle.gBrowser?.selectedBrowser?.contentTitle === "Live transfer fixture";'))
    result = js('''const w=testLittle;window.realBrowsers=[...w.gBrowser.browsers];Object.defineProperty(w.gBrowser,"browsers",{configurable:true,value:[null,...realBrowsers,{isConnected:true,permitUnload(){return {permitUnload:false};}}]});return w.CanCloseWindow();''')
    assert result is False
    js('''const w=testLittle;Object.defineProperty(w.gBrowser,"browsers",{configurable:true,value:[null,...realBrowsers]});window.closeEvents=[];w.gBrowser.tabContainer.addEventListener("TabClose",()=>closeEvents.push("TabClose"));w.document.getElementById("cmd_close").dispatchEvent(new w.Event("command",{bubbles:true,cancelable:true}));''')
    wait_until(lambda: js('return testLittle.closed;'))
    assert js('return closeEvents;') == []
    check_protocol_dispatch(c, url)
    check_launch_cleanup(c, url)
    check_tab_context_move(c, url)
    print('PASS: workspace/container routing, picker search/keyboard/mouse handling, hover layout, live-state adoption, transfer failure safety, and null-safe close')

def main(check=run, visible=False):
    parser=argparse.ArgumentParser()
    parser.add_argument('--zen',default='/Applications/Zen.app/Contents/MacOS/zen',help='Zen executable with fx-autoconfig program loader installed')
    parser.add_argument('--screenshot',help='Optional path for a browser-chrome screenshot')
    args=parser.parse_args()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    (ROOT/'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='test-profile-',dir=ROOT/'work') as temp:
        profile=Path(temp)
        shutil.copytree(ROOT/'vendor/fx-autoconfig/profile/chrome',profile/'chrome')
        (profile/'chrome/JS').mkdir(exist_ok=True);(profile/'chrome/CSS').mkdir(exist_ok=True)
        shutil.copy2(ROOT/'littleZen.uc.js',profile/'chrome/JS/littleZen.uc.js')
        shutil.copy2(ROOT/'little-zen.css',profile/'chrome/CSS/little-zen.css')
        (profile/'chrome/userChrome.css').write_text('@import url("CSS/little-zen.css");\n')
        prefs={'marionette.port':port,'toolkit.legacyUserProfileCustomizations.stylesheets':True,'browser.shell.checkDefaultBrowser':False,'browser.startup.homepage_override.mstone':'ignore','zen.welcome-screen.seen':True}
        (profile/'user.js').write_text('\n'.join('user_pref('+json.dumps(k)+', '+json.dumps(v)+');' for k,v in prefs.items()))
        log=(profile/'process.log').open('w')
        process=subprocess.Popen([args.zen,'-no-remote','-profile',str(profile),*([] if visible else ['-headless']),'--marionette','-remote-allow-system-access','about:blank'],stdout=log,stderr=subprocess.STDOUT)
        client=None
        try:
            def connect():
                try: return Client(port)
                except ConnectionRefusedError: return None
            client=wait_until(connect,30)
            check(client,'http://127.0.0.1:'+str(server.server_port)+'/',args.screenshot)
        finally:
            if client:
                try: client.call('Marionette:Quit',{'flags':['eForceQuit']})
                except Exception: pass
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill();process.wait()
            log.close();server.shutdown()

if __name__=='__main__': main()
