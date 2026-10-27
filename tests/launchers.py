"""Exercise Firefox's real protocol chooser without launching external apps."""
import json
import time


def check_launch_cleanup(client, url):
    def js(script):
        return client.js(script)['value']

    def ajs(script):
        return client.call('WebDriver:ExecuteAsyncScript', {
            'script': script, 'args': [], 'newSandbox': False, 'sandbox': 'default'
        })['value']

    def wait_ready():
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if js('return testLittle.gBrowser?.selectedBrowser?.contentTitle === "Live transfer fixture" && !testLittle.document.documentElement.hasAttribute("zen-little-window-loading");'):
                return
            time.sleep(.1)
        raise TimeoutError('Launcher fixture did not load')

    cases = [
        ('direct launch', {}, True),
        ('accepted prompt', {'ask': True}, True),
        ('canceled prompt', {'ask': True, 'accept': False}, False),
        ('failed prompt', {'ask': True, 'promptError': True}, False),
        ('failed launch', {'fail': True}, False),
        ('continue in browser', {'navigate': True}, False),
        ('ordinary Notion page', {'source': 'https://app.notion.com/a-document'}, False),
        ('untrusted host', {'source': 'https://app.notion.com.example.org/native/p/123'}, False),
        ('unrelated protocol', {'scheme': 'mailto'}, False),
        ('disabled preference', {'enabled': False}, False),
        ('unload refusal', {'refuseUnload': True}, False),
        ('multiple tabs', {'extraTab': True}, False),
    ]
    for name, options, should_close in cases:
        js('window.testLittle=LittleZen.openLittleWindow(window,{url:' + json.dumps(url) + ',source:"launcher-test"});')
        wait_ready()
        result = ajs('''const done=arguments[arguments.length-1];(async()=>{
          const options=''' + json.dumps(options) + ''';
          const w=testLittle,b=w.gBrowser.selectedBrowser;
          // Substitute only the top-level URL; keep the real browser, document,
          // browsing context, protocol chooser implementation, and close path.
          w.__fixtureLauncherURL=options.source??"https://app.notion.com/native/p/123?deepLinkOpenNewTab=true";
          Object.defineProperty(b,"currentURI",{configurable:true,get(){return Services.io.newURI(w.__fixtureLauncherURL);}});
          Services.prefs.setBoolPref("extensions.littleZen.closeAppLaunchers",options.enabled??true);
          Services.prefs.setIntPref("extensions.littleZen.appLaunchCloseDelayMs",500);
          if(options.refuseUnload)w.CanCloseWindow=()=>false;
          if(options.extraTab)w.gBrowser.addTab("about:blank",{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),inBackground:true});
          const {nsContentDispatchChooser}=ChromeUtils.importESModule("resource://gre/modules/ContentDispatchChooser.sys.mjs");
          const chooser=new nsContentDispatchChooser();
          chooser._hasProtocolHandlerPermission=()=>true;
          chooser._prompt=async()=>{if(options.promptError)throw new Error("fixture prompt failure");return options.accept??true;};
          let launches=0,error=null;
          const handler={type:options.scheme??"notion",alwaysAskBeforeHandling:options.ask??false,preferredAction:Ci.nsIHandlerInfo.useSystemDefault,preferredApplicationHandler:null,
            launchWithURI(){if(options.fail)throw new Error("fixture launch failure");launches++;}};
          try{await chooser.handleURI(handler,Services.io.newURI(handler.type+":fixture"),Services.scriptSecurityManager.getSystemPrincipal(),b.browsingContext);}catch(e){error=String(e);}
          if(options.navigate)w.__fixtureLauncherURL="https://app.notion.com/continue-in-browser";
          done({launches,error});
        })().catch(e=>done({unexpected:String(e)}));''')
        assert 'unexpected' not in result, (name, result)
        time.sleep(.8)
        closed = js('return testLittle.closed;')
        assert closed == should_close, (name, result, closed)
        if not closed:
            js('delete testLittle.gBrowser.selectedBrowser.currentURI;testLittle.close();')
    js('Services.prefs.clearUserPref("extensions.littleZen.closeAppLaunchers");Services.prefs.clearUserPref("extensions.littleZen.appLaunchCloseDelayMs");')
    print('PASS: app-launch cleanup after accepted handoff; cancel, failure, navigation, host, protocol, preference, unload and multiple-tab guards')
