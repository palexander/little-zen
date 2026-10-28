"""Move the context tab into Little Zen without reloading its document."""
import json
import time


def check_tab_context_move(c, url):
    def js(script):
        return c.js(script)['value']

    def ajs(script):
        return c.call('WebDriver:ExecuteAsyncScript', {'script': script, 'args': [], 'newSandbox': False, 'sandbox': 'default'})['value']

    def wait(callback, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if callback():
                return
            time.sleep(.1)
        raise TimeoutError('Tab context move did not finish')

    main = c.call('WebDriver:GetWindowHandle')['value']
    result = ajs('''const done=arguments[arguments.length-1];(async()=>{
      window.moveIdentity=ContextualIdentityService.create("Move fixture","fingerprint","blue");
      // The URL intentionally routes elsewhere: a manual move must preserve
      // the tab's current Space and its return destination instead.
      window.moveRouteSpace=await gZenWorkspaces.createAndSaveWorkspace("Different URL route",undefined,false,0);
      for(const r of gZenSpaceRoutingManager.getAllRoutes())gZenSpaceRoutingManager.removeRoute(r.id);
      window.moveSpace=await gZenWorkspaces.createAndSaveWorkspace("Context move space",undefined,true,moveIdentity.userContextId);
      await gZenWorkspaces.changeWorkspaceWithID(moveSpace.uuid);
      window.moveSource=gBrowser.addTab('''+json.dumps(url)+''',{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),userContextId:moveIdentity.userContextId,skipRoute:true});
      gZenWorkspaces.moveTabToWorkspace(moveSource,moveSpace.uuid);gBrowser.selectedTab=moveSource;
      done(true);
    })().catch(e=>done({error:String(e)}));''')
    assert result is True, result
    wait(lambda: js('return moveSource.linkedBrowser?.contentTitle === "Live transfer fixture";'))
    source_context_id = js('return moveSource.linkedBrowser.browsingContext.id;')
    for handle in c.call('WebDriver:GetWindowHandles'):
        c.call('WebDriver:SwitchToWindow', {'handle': handle})
        if js('return gBrowser.selectedBrowser.browsingContext.id === '+str(source_context_id)+';'):
            break
    c.call('Marionette:SetContext', {'value': 'content'})
    state_script = 'return {token:window.contextMoveToken,draft:document.getElementById("draft")?.value,timeOrigin:performance.timeOrigin,history:history.length,state:history.state,scroll:scrollY,cookie:document.cookie,url:location.href};'
    js('window.contextMoveToken="live context menu move";document.getElementById("draft").value="unsaved context draft";history.pushState({contextMove:42},"","#context-move");scrollTo(0,500);document.cookie="context_move=preserved;path=/";')
    before = js(state_script)
    c.call('Marionette:SetContext', {'value': 'chrome'})
    c.call('WebDriver:SwitchToWindow', {'handle': main})
    js('''window.moveContextId=moveSource.linkedBrowser.browsingContext.id;
      window.moveOther=gBrowser.addTab("about:blank",{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal(),skipRoute:true});
      gZenWorkspaces.moveTabToWorkspace(moveOther,moveSpace.uuid);gBrowser.selectedTab=moveOther;
      const route=gZenSpaceRoutingManager.createNewRoute();Object.assign(route,{reference:"127.0.0.1",matchType:"contains",openIn:moveRouteSpace.uuid});gZenSpaceRoutingManager.updateRoute(route);''')

    def open_menu():
        js('''gBrowser.selectedTab=moveOther;const popup=document.getElementById("tabContextMenu");const event=new MouseEvent("contextmenu",{bubbles:true,button:2});moveSource.dispatchEvent(event);popup.openPopup(moveSource,"after_start",0,0,true,false,event);''')
        wait(lambda: js('return document.getElementById("tabContextMenu").state === "open";'))
        result = js('''const item=document.getElementById("context_moveTabToLittleZen");return {label:item?.getAttribute("label"),disabled:item?.disabled,context:TabContextMenu.contextTab===moveSource};''')
        assert result == {'label': 'Move to Little Zen', 'disabled': False, 'context': True}, result

    # Failed adoption must preserve the source and close only the unused window.
    for mode in ['null', 'throw']:
        js('''window.failedMoveDestination=null;
          window.moveFailureObserver={observe(w){if(w===window||!w.document.documentElement.hasAttribute("zen-little-window"))return;
            Services.obs.removeObserver(moveFailureObserver,"browser-delayed-startup-finished");failedMoveDestination=w;
            w.gBrowser.adoptTab=function(){'''+('return null;' if mode == 'null' else 'throw new Error("fixture adoption failure");')+'''};
          }};Services.obs.addObserver(moveFailureObserver,"browser-delayed-startup-finished");''')
        assert js('return moveSource.getAttribute("zen-workspace-id")===moveSpace.uuid;'), 'Source fixture moved to another Space before the request'
        open_menu()
        js('document.getElementById("context_moveTabToLittleZen").dispatchEvent(new Event("command",{bubbles:true}));document.getElementById("tabContextMenu").hidePopup();')
        wait(lambda: js('return !!failedMoveDestination?.closed && !moveSource.__littleZenMoveInProgress;'))
        assert js('return moveSource.isConnected && moveSource.linkedBrowser.browsingContext.id===moveContextId;')
    open_menu()
    element = c.call('WebDriver:FindElement', {'using':'css selector', 'value':'#context_moveTabToLittleZen'})
    element = element.get('value', element)
    c.call('WebDriver:ElementClick', {'id':next(iter(element.values()))})
    wait(lambda: js('return !moveSource.isConnected;'))
    wait(lambda: js('window.movedLittle=[...Services.wm.getEnumerator("navigator:browser")].find(w=>w.document.documentElement.hasAttribute("zen-little-window")&&w.gBrowser?.selectedBrowser?.browsingContext.id===moveContextId);return !!movedLittle&&!moveSource.__littleZenMoveInProgress;'))
    result = js('''const w=movedLittle;return {context:w.gBrowser.selectedBrowser.browsingContext.id===moveContextId,space:w.gZenWorkspaces.activeWorkspace===moveSpace.uuid,tabSpace:w.gBrowser.selectedTab.getAttribute("zen-workspace-id")===moveSpace.uuid,container:w.gBrowser.selectedTab.userContextId===moveIdentity.userContextId,otherTabPreserved:moveOther.isConnected,tabs:[...w.gBrowser.tabs].filter(t=>t!==w.gZenWorkspaces._emptyTab&&!t.closing).length,picker:w.document.getElementById("zen-little-window-space-picker-open")?.getAttribute("label")};''')
    assert result == {'context': True, 'space': True, 'tabSpace': True, 'container': True, 'otherTabPreserved': True, 'tabs': 1, 'picker': 'Open in Context move space'}, result
    context_id = js('return moveContextId;')
    for handle in c.call('WebDriver:GetWindowHandles'):
        c.call('WebDriver:SwitchToWindow', {'handle': handle})
        if js('return gBrowser.selectedBrowser.browsingContext.id === '+str(context_id)+';'):
            break
    c.call('Marionette:SetContext', {'value': 'content'})
    after = js(state_script)
    assert before == after, {'before': before, 'after': after}
    c.call('Marionette:SetContext', {'value': 'chrome'})
    c.call('WebDriver:SwitchToWindow', {'handle': main})
    js('movedLittle.close();gBrowser.removeTab(moveOther,{animate:false});')
    print('PASS: tab right-click moves the background context tab live, preserves Space/container/state, and survives adoption failures', flush=True)
