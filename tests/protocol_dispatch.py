"""Verify the actual content-to-protocol-chooser path using a local web handler."""
import json
import time


def check_protocol_dispatch(client, url):
    def js(script):
        return client.js(script)['value']

    def wait(callback):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if callback():
                return
            time.sleep(.1)
        raise TimeoutError('Real protocol dispatch did not complete')

    main = client.call('WebDriver:GetWindowHandle')['value']
    js('window.testLittle=LittleZen.openLittleWindow(window,{url:' + json.dumps(url) + ',source:"protocol-dispatch-test"});')
    wait(lambda: js('return testLittle.gBrowser?.selectedBrowser?.contentTitle === "Live transfer fixture" && !testLittle.document.documentElement.hasAttribute("zen-little-window-loading");'))
    js('''const {nsContentDispatchChooser}=ChromeUtils.importESModule("resource://gre/modules/ContentDispatchChooser.sys.mjs");
      window.testChooserPrototype=nsContentDispatchChooser.prototype;
      window.originalTestHandleURI=testChooserPrototype.handleURI;
      window.testProtocolDispatches=[];
      testChooserPrototype.handleURI=function(...args){
        testProtocolDispatches.push({scheme:args[1]?.scheme,sourceIsLittle:args[3]?.topFrameElement===testLittle.gBrowser.selectedBrowser});
        return originalTestHandleURI.apply(this,args);
      };
      const service=Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService);
      const info=service.getProtocolHandlerInfo("web+littlezen-fixture");
      const app=Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(Ci.nsIWebHandlerApp);
      app.name="Local protocol fixture";app.uriTemplate=''' + json.dumps(url + 'handled?uri=%s') + ''';
      info.preferredApplicationHandler=app;info.preferredAction=Ci.nsIHandlerInfo.useHelperApp;info.alwaysAskBeforeHandling=false;
      Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService).store(info);
      Services.prefs.setBoolPref("network.protocol-handler.external.web+littlezen-fixture",true);
      Services.perms.addFromPrincipal(testLittle.gBrowser.selectedBrowser.contentPrincipal,"open-protocol-handler^web+littlezen-fixture",Services.perms.ALLOW_ACTION);''')
    try:
        for handle in client.call('WebDriver:GetWindowHandles'):
            client.call('WebDriver:SwitchToWindow', {'handle': handle})
            if js('return document.documentElement.hasAttribute("zen-little-window");'):
                break
        client.call('Marionette:SetContext', {'value': 'content'})
        js('const a=document.createElement("a");a.id="protocol-fixture";a.href="web+littlezen-fixture:launch";a.textContent="Launch fixture";document.body.prepend(a);')
        element = client.call('WebDriver:FindElement', {'using': 'css selector', 'value': '#protocol-fixture'})
        element = element.get('value', element)
        client.call('WebDriver:ElementClick', {'id': next(iter(element.values()))})
        client.call('Marionette:SetContext', {'value': 'chrome'})
        client.call('WebDriver:SwitchToWindow', {'handle': main})
        wait(lambda: js('return testLittle.gBrowser.selectedBrowser.currentURI.spec.includes("/handled?uri=");'))
        assert js('return testProtocolDispatches;') == [{'scheme': 'web+littlezen-fixture', 'sourceIsLittle': True}]
        assert js('return !testLittle.closed;'), 'Web handlers must not trigger native-app cleanup'
    finally:
        client.call('Marionette:SetContext', {'value': 'chrome'})
        client.call('WebDriver:SwitchToWindow', {'handle': main})
        js('testChooserPrototype.handleURI=originalTestHandleURI;if(!testLittle.closed)testLittle.close();')
    print('PASS: actual content protocol dispatch reaches the patched chooser; local web handler stays open', flush=True)
