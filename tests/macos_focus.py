#!/usr/bin/env python3
"""Interactive native macOS regression; all browser windows use a temporary profile."""
import json
import sys
import time
import run as suite


def check_focus(client, url, screenshot):
    def js(script):
        return client.js(script)['value']

    suite.wait_until(lambda: js('return window.gZenStartup?.isReady;'))
    js('document.title="Focus test A";resizeTo(600,500);moveTo(60,80);window.testSecond=OpenBrowserWindow({});')
    suite.wait_until(lambda: js('return testSecond.gZenStartup?.isReady;'))
    js('testSecond.document.title="Focus test B";testSecond.resizeTo(600,500);testSecond.moveTo(180,150);')
    js('''const {BrowserWindowTracker}=ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
      const b=BrowserWindowTracker.__littleZenMacWindowFocusBridge;
      if(!b)throw new Error("Native bridge unavailable");
      const c=b.ctypes;
      const sel=b.objc.declare("sel_registerName",c.default_abi,c.voidptr_t,c.char.ptr);
      const cls=b.objc.declare("objc_getClass",c.default_abi,c.voidptr_t,c.char.ptr);
      const object=b.objc.declare("objc_msgSend",c.default_abi,c.voidptr_t,c.voidptr_t,c.voidptr_t);
      const bool=b.objc.declare("objc_msgSend",c.default_abi,c.bool,c.voidptr_t,c.voidptr_t);
      const number=b.objc.declare("objc_msgSend",c.default_abi,c.long,c.voidptr_t,c.voidptr_t);
      const getPid=b.objc.declare("objc_msgSend",c.default_abi,c.int32_t,c.voidptr_t,c.voidptr_t);
      const workspace=object(cls("NSWorkspace"),sel("sharedWorkspace"));
      const send=b.objc.declare("objc_msgSend",c.default_abi,c.void_t,c.voidptr_t,c.voidptr_t);
      const activate=b.objc.declare("objc_msgSend",c.default_abi,c.void_t,c.voidptr_t,c.voidptr_t,c.bool);
      const app=object(cls("NSApplication"),sel("sharedApplication"));
      const native=w=>c.voidptr_t(c.UInt64(w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle));
      window.focusProbe={
        order:()=>b.snapshotOrder(),active:()=>bool(app,sel("isActive")),
        foregroundPid:()=>getPid(object(workspace,sel("frontmostApplication")),sel("processIdentifier")),
        key:w=>bool(native(w),sel("isKeyWindow")),
        makeNormalKey:()=>send(native(window),sel("makeKeyWindow")),
        number:w=>Number(number(native(w),sel("windowNumber")).toString()),
        bounds:()=>[window,testSecond].map(w=>({x:w.screenX,y:w.screenY,width:w.outerWidth,height:w.outerHeight})),
        force(){activate(app,sel("activateIgnoringOtherApps:"),true);for(const w of [window,testSecond])send(native(w),sel("orderFrontRegardless"));}
      };''')
    input('Return to this terminal so Zen is inactive, then press Enter to test: ')
    assert js('return !focusProbe.active();'), 'The test Zen process must be inactive before starting'
    time.sleep(.35)  # Allow the inactive snapshot poll to see the terminal.
    js('''window.focusSourcePid=focusProbe.foregroundPid();window.focusBefore=focusProbe.order();window.focusBounds=focusProbe.bounds();
      window.focusNormalIds=[focusProbe.number(window),focusProbe.number(testSecond)];
      focusProbe.force();
      setTimeout(()=>{window.focusForced=focusProbe.order();window.testLittle=LittleZen.openLittleWindow(window,{url:'''+json.dumps(url)+''',source:"browserDOMWindow.openURI"});},150);''')
    suite.wait_until(lambda: js('return window.testLittle?.__littleZenStartupReady && focusProbe.key(testLittle);'))
    time.sleep(.25)
    result = js('return {before:focusBefore,forced:focusForced,after:focusProbe.order(),normal:focusNormalIds,little:focusProbe.number(testLittle),active:focusProbe.active(),key:focusProbe.key(testLittle),beforeBounds:focusBounds,afterBounds:focusProbe.bounds()};')
    assert all(result['forced'].index(i) < result['before'].index(i) for i in result['normal']), 'Failed to reproduce app-wide window raising'
    common = set(result['before']) & set(result['after'])
    assert [i for i in result['before'] if i in common] == [i for i in result['after'] if i in common], 'Previous window order changed'
    assert result['beforeBounds'] == result['afterBounds'], 'Normal-window geometry changed'
    assert result['active'] and result['key'], 'Little Zen did not receive keyboard focus'
    assert all(result['after'].index(result['little']) < result['after'].index(i) for i in result['normal'])
    # A canceled close must not return focus; a real foreground close must.
    js('window.realCanClose=testLittle.CanCloseWindow;testLittle.CanCloseWindow=()=>false;testLittle.BrowserCommands.tryToCloseWindow();')
    assert js('return !testLittle.closed&&focusProbe.active()&&focusProbe.key(testLittle);')
    js('testLittle.CanCloseWindow=realCanClose;testLittle.addEventListener("DOMWindowClose",e=>e.preventDefault(),{once:true});testLittle.close();')
    time.sleep(.1)
    assert js('return !testLittle.closed&&focusProbe.active()&&focusProbe.key(testLittle);'), 'Canceled DOM close handed off focus'
    js('focusProbe.makeNormalKey();')
    assert js('return focusProbe.active()&&!focusProbe.key(testLittle);'), 'Failed to reproduce native key-window clearing'
    js('window.focusAppAtUnload=null;testLittle.addEventListener("unload",()=>{focusAppAtUnload=focusProbe.foregroundPid();},{once:true});testLittle.BrowserCommands.tryToCloseWindow();')
    suite.wait_until(lambda: js('return testLittle.closed&&!focusProbe.active()&&focusProbe.foregroundPid()===focusSourcePid;'))
    if js('return Services.prefs.getBoolPref("extensions.littleZen.returnBeforeClose",false);'):
        assert js('return focusAppAtUnload===focusSourcePid;'), 'Handoff happened after native unload'
    assert js('return JSON.stringify(focusProbe.bounds())===JSON.stringify(focusBounds);')
    print('PASS: app-wide activation restores prior order/bounds; Little Zen receives focus; canceled close retains focus; confirmed native close after key-window clearing returns to its source app')


if __name__ == '__main__':
    if sys.platform != 'darwin' or not sys.stdin.isatty():
        raise SystemExit('Run this macOS test from an interactive terminal.')
    suite.main(check=check_focus, visible=True)
