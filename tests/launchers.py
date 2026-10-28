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
    cases += [
        ('legacy Notion host', {'source':'https://www.notion.so/native/p/123?deepLinkOpenNewTab=true'}, True),
        ('Zoom completion marker', {'source':'https://us02.zoom.us/j/123?pwd=test#success','scheme':'zoommtg'}, True),
        ('ZoomGov completion marker', {'source':'https://agency.zoomgov.us/s/123#success','scheme':'zoommtg'}, True),
        ('Zoom delayed marker', {'source':'https://zoom.us/j/123','scheme':'zoommtg','afterSource':'https://zoom.us/j/123#success'}, True),
        ('Zoom launch from child frame', {'source':'https://zoom.us/j/123','scheme':'zoommtg','afterSource':'https://zoom.us/j/123#success','subframe':True}, True),
        ('Zoom missing marker', {'source':'https://zoom.us/j/123','scheme':'zoommtg'}, False),
        ('Zoom browser fallback', {'source':'https://zoom.us/j/123#success','scheme':'zoommtg','afterSource':'https://zoom.us/wc/123/join'}, False),
        ('Teams web+msteams protocol', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2Fmeet%2Ffixture&type=meet&msLaunch=true','scheme':'web+msteams'}, True),
        ('Teams same-document launch flags', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2Fmeet%2Ffixture&type=meet','scheme':'web+msteams','afterSource':'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2Fmeet%2Ffixture&type=meet&suppressPrompt=true&suppressAutoDownload=true&promptSuccess=true'}, True),
        ('Teams different meeting stays open', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=meeting-a','scheme':'web+msteams','afterSource':'https://teams.microsoft.com/dl/launcher/launcher.html?url=meeting-b&suppressPrompt=true'}, False),
        ('Teams browser fallback stays open', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=fixture','scheme':'web+msteams','afterSource':'https://teams.microsoft.com/v2/'}, False),
        ('Teams work', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=test','scheme':'msteams'}, True),
        ('Teams personal', {'source':'https://teams.live.com/dl/launcher/launcher.html?url=test','scheme':'msteams'}, True),
        ('Teams cloud', {'source':'https://teams.cloud.microsoft/dl/launcher/launcher.html?url=test','scheme':'ms-teams'}, True),
        ('Slack handoff', {'source':'https://example.enterprise.slack.com/ssb/signin_redirect?x=1','scheme':'slack'}, True),
        ('Slack web client', {'source':'https://app.slack.com/client/T1/C1','scheme':'slack'}, False),
        ('Discord invite', {'source':'https://discord.gg/abc','scheme':'discord'}, True),
        ('Linear delayed marker', {'source':'https://linear.app/example/issue/ABC-1','scheme':'linear','afterSource':'https://linear.app/example/issue/ABC-1?noRedirect=1'}, True),
        ('Linear settings excluded', {'source':'https://linear.app/example/settings?noRedirect=1','scheme':'linear'}, False),
        ('Figma disabled by default', {'source':'https://figma.com/design/abc/name','scheme':'figma'}, False),
        ('Figma opted in', {'source':'https://figma.com/design/abc/name','scheme':'figma','preset':'figma','presetEnabled':True}, True),
        ('Spotify disabled by default', {'source':'https://open.spotify.com/track/abc','scheme':'spotify'}, False),
        ('Spotify opted in', {'source':'https://open.spotify.com/track/abc','scheme':'spotify','preset':'spotify','presetEnabled':True}, True),
        ('Teams disabled', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=test','scheme':'msteams','preset':'teams','presetEnabled':False}, False),
        ('Teams wrong protocol', {'source':'https://teams.microsoft.com/dl/launcher/launcher.html?url=test','scheme':'notion'}, False),
        ('Teams lookalike host', {'source':'https://teams.microsoft.com.example.org/dl/launcher/launcher.html?url=test','scheme':'msteams'}, False),
    ]
    for name, options, should_close in cases:
        fixture_url = url + 'launcher-with-frame' if options.get('subframe') else url
        js('window.testLittle=LittleZen.openLittleWindow(window,{url:' + json.dumps(fixture_url) + ',source:"launcher-test"});')
        wait_ready()
        print('Checking launcher:',name,flush=True)
        result = ajs('''const done=arguments[arguments.length-1];(async()=>{
          const options=''' + json.dumps(options) + ''';
          const w=testLittle,b=w.gBrowser.selectedBrowser;
          // Substitute only the top-level URL; keep the real browser, document,
          // browsing context, protocol chooser implementation, and close path.
          w.__fixtureLauncherURL=options.source??"https://app.notion.com/native/p/123?deepLinkOpenNewTab=true";
          Object.defineProperty(b,"currentURI",{configurable:true,get(){return Services.io.newURI(w.__fixtureLauncherURL);}});
          Services.prefs.setBoolPref("extensions.littleZen.closeAppLaunchers",options.enabled??true);
          Services.prefs.setIntPref("extensions.littleZen.appLaunchCloseDelayMs",500);
          for(const id of ["zoom","slack","teams","notion","discord","linear","figma","spotify"])Services.prefs.clearUserPref("extensions.littleZen.appLaunchers."+id);
          if(options.preset)Services.prefs.setBoolPref("extensions.littleZen.appLaunchers."+options.preset,options.presetEnabled);
          if(options.refuseUnload)w.CanCloseWindow=()=>false;
          if(options.extraTab)w.gBrowser.addTab("about:blank",{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),inBackground:true});
          const {nsContentDispatchChooser}=ChromeUtils.importESModule("resource://gre/modules/ContentDispatchChooser.sys.mjs");
          const chooser=new nsContentDispatchChooser();
          chooser._hasProtocolHandlerPermission=()=>true;
          chooser._prompt=async()=>{if(options.promptError)throw new Error("fixture prompt failure");return options.accept??true;};
          let launches=0,error=null;
          const handler={type:options.scheme??"notion",alwaysAskBeforeHandling:options.ask??false,preferredAction:Ci.nsIHandlerInfo.useSystemDefault,preferredApplicationHandler:null,
            launchWithURI(){if(options.fail)throw new Error("fixture launch failure");launches++;}};
          const context=options.subframe?b.browsingContext.children[0]:b.browsingContext;
          if(!context)throw new Error("missing fixture browsing context");
          try{await chooser.handleURI(handler,Services.io.newURI(handler.type+":fixture"),Services.scriptSecurityManager.getSystemPrincipal(),context);}catch(e){error=String(e);}
          if(options.afterSource)w.__fixtureLauncherURL=options.afterSource;
          if(options.navigate)w.__fixtureLauncherURL="https://app.notion.com/continue-in-browser";
          done({launches,error});
        })().catch(e=>done({unexpected:String(e)}));''')
        assert 'unexpected' not in result, (name, result)
        time.sleep(1.2)
        closed = js('return testLittle.closed;')
        assert closed == should_close, (name, result, closed)
        if not closed:
            js('delete testLittle.gBrowser.selectedBrowser.currentURI;testLittle.close();')
    js('Services.prefs.clearUserPref("extensions.littleZen.closeAppLaunchers");Services.prefs.clearUserPref("extensions.littleZen.appLaunchCloseDelayMs");')
    js('for(const id of ["zoom","slack","teams","notion","discord","linear","figma","spotify"])Services.prefs.clearUserPref("extensions.littleZen.appLaunchers."+id);')
    print('PASS: multi-app presets, delayed completion markers, per-app opt-ins, and app-launch cleanup after accepted handoff; cancel, failure, navigation, host, protocol, preference, unload and multiple-tab guards')
