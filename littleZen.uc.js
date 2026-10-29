// ==UserScript==
// @name        Little Zen
// @description Little Zen with workspace routing, live tab promotion, and native macOS controls
// @include     main
// @ignorecache
// ==/UserScript==

(function () {
  "use strict";

  const LITTLE_WINDOW_ATTR = "zen-little-window";
  const COMMAND_ID = "cmd_zenNewLittleWindow";
  const URLBAR_HEIGHT = 340;
  const URLBAR_WIDTH = 640;
  const NORMAL_WINDOW_WIDTH = 1000;
  const NORMAL_WINDOW_HEIGHT = 600;
  const OPEN_FEATURES =
    "titlebar,close,toolbar,location,personalbar=no,status,menubar=no," +
    `resizable,minimizable,scrollbars,width=${URLBAR_WIDTH},height=${URLBAR_HEIGHT},centerscreen`;
  const LITTLE_ZEN_THEME_CACHE_LIMIT = 200;
  const LITTLE_ZEN_THEME_MESSAGE_NAME = "little-zen:theme-response";
  const LITTLE_ZEN_THEME_BRIDGE_TIMEOUT_MS = 250;
  const LITTLE_ZEN_ROUTING_DEBUG_PREF = "extensions.littleZen.debugRouting";
  const LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS = 25000;

  const PATCH_FLAGS = {
    browserWindowTracker: "__littleZenBrowserWindowTrackerPatched",
    uriLoadingHelper: "__littleZenUriLoadingHelperPatched",
    browserDOMWindow: "__littleZenBrowserDOMWindowPatched",
    openBrowserWindow: "__littleZenOpenBrowserWindowPatched",
    compactMode: "__littleZenCompactModePatched",
    verticalTabs: "__littleZenVerticalTabsPatched",
    zenUIManager: "__littleZenZenUIManagerPatched",
    urlbar: "__littleZenUrlbarPatched",
    urlbarDisableGuard: "__littleZenUrlbarDisableGuardAttached",
    emptyState: "__littleZenEmptyStatePatched",
    autoClose: "__littleZenAutoCloseAttached",
    doubleEscapeClose: "__littleZenDoubleEscapeCloseAttached",
    keyListener: "__littleZenKeyListenerAttached",
    tabClickListener: "__littleZenTabClickListenerAttached",
    contentLinkListener: "__littleZenContentLinkListenerAttached",
    window: "__littleZenBootstrapped",
  };
  const littleZenThemeCache = new Map();
  let littleZenThemeRequestSeq = 0;

  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  );
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const { ClickHandlerParent } = ChromeUtils.importESModule(
    "resource:///actors/ClickHandlerParent.sys.mjs"
  );
  const { URILoadingHelper } = ChromeUtils.importESModule(
    "resource:///modules/URILoadingHelper.sys.mjs"
  );

  try {
    ChromeUtils.importESModule("resource:///modules/zen/ZenLittleWindow.sys.mjs");
    console.log("[LittleZen]", "Native Little Zen support detected; skipping backport.");
    return;
  } catch (error) {}

  function formatLogArg(arg) {
    if (arg === undefined) {
      return "undefined";
    }
    if (arg === null) {
      return "null";
    }
    if (typeof arg === "string") {
      return arg;
    }
    if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") {
      return String(arg);
    }
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}`;
    }
    if (typeof arg?.message === "string") {
      return `${arg.name ?? "Error"}: ${arg.message}`;
    }
    if (typeof arg?.spec === "string") {
      return arg.spec;
    }
    try {
      return JSON.stringify(arg);
    } catch (error) {
      try {
        return String(arg);
      } catch (stringError) {
        return "[unserializable]";
      }
    }
  }

  function log(...args) {
    const message = `[LittleZen] ${args.map(formatLogArg).join(" ")}`;
    console.log("[LittleZen]", ...args);
    try {
      Services.console.logStringMessage(message);
    } catch (error) {}
    try {
      const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
      file.append("little-zen-debug.log");
      const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
        Ci.nsIFileOutputStream
      );
      stream.init(file, 0x1a, 0o600, 0);
      const converter = Cc[
        "@mozilla.org/intl/converter-output-stream;1"
      ].createInstance(Ci.nsIConverterOutputStream);
      converter.init(stream, "UTF-8");
      converter.writeString(`${new Date().toISOString()} ${message}\n`);
      converter.close();
    } catch (error) {}
  }

  function isRoutingDebugEnabled() {
    try {
      return Services.prefs.getBoolPref(LITTLE_ZEN_ROUTING_DEBUG_PREF, false);
    } catch (error) {
      return false;
    }
  }

  function routeLog(...args) {
    if (isRoutingDebugEnabled()) {
      log(...args);
    }
  }

  function isBrowserWindow(win) {
    return (
      !!win &&
      !win.closed &&
      win.location?.href === "chrome://browser/content/browser.xhtml"
    );
  }

  function isLittleWindow(win) {
    return (
      isBrowserWindow(win) &&
      (win._zenStartupLittleWindow ||
        win.document?.documentElement?.hasAttribute(LITTLE_WINDOW_ATTR))
    );
  }

  function isEmptyLittleWindow(win) {
    return isLittleWindow(win) && !!win.gBrowser?.selectedTab?.hasAttribute("zen-empty-tab");
  }

  function usesEmptyLittleWindowPresentation(win) {
    return isEmptyLittleWindow(win) && !win.__littleZenStartExpanded;
  }

  function isExternalOpenContext(context) {
    return (
      context === Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL ||
      (typeof context === "number" &&
        !!(context & Ci.nsIWebNavigation.LOAD_FLAGS_FROM_EXTERNAL))
    );
  }

  function getLittleWindowState(win) {
    const root = win?.document?.documentElement;
    const tab = win?.gBrowser?.selectedTab;
    const urlbar = win?.gURLBar;

    return {
      littleWindow: isLittleWindow(win),
      startupReady: !!win?.__littleZenStartupReady,
      pendingUrl: win?.__littleZenPendingURL ?? null,
      rootEmpty: !!root?.hasAttribute("zen-has-empty-tab"),
      tabEmpty: !!tab?.hasAttribute("zen-empty-tab"),
      urlbarBreakout: !!urlbar?.hasAttribute("breakout-extend"),
      urlbarOpen: !!urlbar?.view?.isOpen,
      urlbarNewtab: !!urlbar?.hasAttribute("zen-newtab"),
      currentUrl: win?.gBrowser?.selectedBrowser?.currentURI?.spec ?? null,
      compactMode: root?.getAttribute("zen-compact-mode") ?? null,
      singleToolbar: !!root?.hasAttribute("zen-single-toolbar"),
      navbarParent: win?.document?.getElementById("nav-bar")?.parentElement?.id ?? null,
      backButtonParent:
        win?.document?.getElementById("back-button")?.parentElement?.id ?? null,
      urlbarParent:
        win?.document?.getElementById("urlbar-container")?.parentElement?.id ?? null,
    };
  }

  function isExternalStartupWindow(win) {
    try {
      const extraOptions = win.arguments?.[1];
      return (
        extraOptions instanceof Ci.nsIPropertyBag2 &&
        extraOptions.hasKey("fromExternal") &&
        extraOptions.getPropertyAsBool("fromExternal")
      );
    } catch (error) {
      return false;
    }
  }

  function getExternalStartupUrl(win) {
    const argument = win.arguments?.[0];
    if (typeof argument === "string") {
      return argument;
    }
    if (argument?.spec) {
      return argument.spec;
    }
    try {
      return argument?.queryElementAt?.(0, Ci.nsIURI)?.spec ?? null;
    } catch (error) {
      return null;
    }
  }

  function logLittleWindowState(win, label, extra = undefined) {
    log(label, {
      ...getLittleWindowState(win),
      ...(extra ?? {}),
    });
  }

  function centerWindow(win) {
    try {
      win.docShell?.treeOwner
        ?.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow)
        .center(null, true, true);
    } catch (error) {
      log("Could not center the Little Zen window.", error);
    }
  }

  function setWindowResizable(win, isResizable) {
    try {
      win.setResizable?.(isResizable);
    } catch (error) {
      log("Could not update the Little Zen resizable state.", error);
    }
  }

  function markLittleWindowEarly(win, options = {}) {
    if (!win?.document?.documentElement) {
      return;
    }

    win._zenStartupLittleWindow = true;
    win.__littleZenPresentationReleased = false;
    if (options.expanded !== undefined) {
      win.__littleZenStartExpanded = !!options.expanded;
    }
    if (options.url) {
      win.__littleZenStartLoadingVeil = true;
      win.__littleZenPendingURL = options.url;
      win.__littleZenRoutedURL = options.url;
      if (options.meta) {
        win.__littleZenPendingURLMeta = options.meta;
      }
    }

    try {
      const root = win.document.documentElement;
      root.setAttribute(LITTLE_WINDOW_ATTR, "true");
      root.toggleAttribute("zen-little-window-loading", !!options.url);
    } catch (error) {
      log("Could not mark Little Zen window early", error);
    }
  }

  function releaseLittleWindowPresentation(win, reason = "unknown") {
    if (!isBrowserWindow(win) || win.__littleZenPresentationReleased) {
      return;
    }

    if (win.document?.documentElement?.hasAttribute("zen-little-window-loading")) {
      win.__littleZenReleasePresentationAfterLoading = reason;
      logLittleWindowState(win, "Deferred Little Zen presentation release while loading", {
        reason,
      });
      return;
    }

    win.__littleZenPresentationReleased = true;
    logLittleWindowState(win, "Released Little Zen startup presentation", {
      reason,
    });
  }

  function cleanupLittleWindowLifecycle(win, reason = "unknown") {
    const cleanup = win.__littleZenLifecycleCleanup;
    if (typeof cleanup === "function") {
      cleanup(reason);
    }
  }

  const LITTLE_ZEN_GEOMETRY_PREF = "extensions.littleZen.windowGeometry";

  function readLittleWindowGeometry() {
    try {
      const bounds = JSON.parse(Services.prefs.getStringPref(LITTLE_ZEN_GEOMETRY_PREF, "null"));
      if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
          bounds.width >= 360 && bounds.height >= 240) {
        return bounds;
      }
    } catch (error) {}
    return null;
  }

  function rememberLittleWindowGeometry(win) {
    if (win.__littleZenGeometryTracking) {
      return;
    }
    win.__littleZenGeometryTracking = true;
    let timer;
    const save = () => {
      if (win.windowState !== win.STATE_NORMAL || !win.__littleZenGeometryRestored) {
        return;
      }
      const bounds = {
        x: Math.round(win.screenX), y: Math.round(win.screenY),
        width: Math.round(win.outerWidth), height: Math.round(win.outerHeight),
      };
      if (bounds.width >= 360 && bounds.height >= 240) {
        Services.prefs.setStringPref(LITTLE_ZEN_GEOMETRY_PREF, JSON.stringify(bounds));
      }
    };
    const scheduleSave = () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(save, 250);
    };
    for (const event of ["resize", "MozUpdateWindowPos", "sizemodechange"]) {
      win.addEventListener(event, scheduleSave);
    }
    win.addEventListener("unload", () => {
      win.clearTimeout(timer);
      save();
    }, { once: true });
  }

  function restoreLittleWindowGeometry(win) {
    // A later navigation must not resize a window the user already arranged.
    if (win.__littleZenGeometryRestored) {
      return;
    }
    const bounds = readLittleWindowGeometry();
    if (bounds) {
      win.moveTo(bounds.x, bounds.y);
      const screen = win.screen;
      const width = Math.min(bounds.width, screen.availWidth);
      const height = Math.min(bounds.height, screen.availHeight);
      win.resizeTo(width, height);
      // Keep the window reachable if a previously used display was unplugged.
      const x = Math.max(screen.availLeft, Math.min(bounds.x, screen.availLeft + screen.availWidth - width));
      const y = Math.max(screen.availTop, Math.min(bounds.y, screen.availTop + screen.availHeight - height));
      win.moveTo(x, y);
    } else {
      win.resizeTo(NORMAL_WINDOW_WIDTH, NORMAL_WINDOW_HEIGHT);
      centerWindow(win);
    }
    win.__littleZenGeometryRestored = true;
    rememberLittleWindowGeometry(win);
  }

  function expandLittleWindow(win, reason = "unknown") {
    cleanupLittleWindowLifecycle(win, `expand:${reason}`);
    if (!isBrowserWindow(win) || win.closed) {
      return;
    }

    try {
      win.document.documentElement.removeAttribute("zen-no-padding");
      updateLittleZenBlendedTheme(win, `expand:${reason}`);
    } catch (error) {
      log("Could not prepare Little Zen blended frame while expanding", error);
    }

    setWindowResizable(win, true);
    try {
      restoreLittleWindowGeometry(win);
      logLittleWindowState(win, "Expanded Little Zen window", { reason });
    } catch (error) {
      log("Could not expand the Little Zen window.", error);
    }
  }

  function* browserWindows() {
    const windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      const browserWindow = windows.getNext();
      if (isBrowserWindow(browserWindow)) {
        yield browserWindow;
      }
    }
  }

  function getFallbackBrowserWindow(options = {}) {
    for (const browserWindow of browserWindows()) {
      if (
        !browserWindow.closed &&
        !isLittleWindow(browserWindow) &&
        (options.allowPopups || browserWindow.toolbar.visible) &&
        (!("private" in options) ||
          PrivateBrowsingUtils.permanentPrivateBrowsing ||
          PrivateBrowsingUtils.isWindowPrivate(browserWindow) === options.private) &&
        !browserWindow.document.documentElement.hasAttribute("taskbartab")
      ) {
        return browserWindow;
      }
    }
    return null;
  }

  // URL patterns adapted from App Tab Cleaner (MIT, Bereket Abraham).
  // Pinned upstream source and license: vendor/app-tab-cleaner/.
  const APP_LAUNCH_PRESETS = [
    {
      "id": "zoom",
      "schemes": [
        "zoommtg",
        "zoomus",
        "zoomgov"
      ],
      "include": [
        "^https://([a-z0-9-]+\\.)?zoom(gov)?\\.us/[jsw]/[^/?#]+[^#]*#success$"
      ],
      "exclude": [],
      "enabled": true
    },
    {
      "id": "slack",
      "schemes": [
        "slack"
      ],
      "include": [
        "^https://([a-z0-9-]+\\.)?(enterprise\\.)?slack\\.com/(archives/|app_redirect\\b|ssb/(signin_)?redirect)"
      ],
      "exclude": [],
      "enabled": true
    },
    {
      "id": "teams",
      "schemes": [
        "msteams",
        "ms-teams",
        "web+msteams"
      ],
      "include": [
        "^https://teams\\.(microsoft\\.com|live\\.com|cloud\\.microsoft)/dl/launcher/launcher\\.html\\?"
      ],
      "exclude": [],
      "enabled": true
    },
    {
      "id": "notion",
      "schemes": [
        "notion"
      ],
      "include": [
        "^https://(www\\.notion\\.so|app\\.notion\\.com)/native/.*[?&]deepLinkOpenNewTab=true"
      ],
      "exclude": [],
      "enabled": true
    },
    {
      "id": "discord",
      "schemes": [
        "discord"
      ],
      "include": [
        "^https://(discord(app)?\\.com/invite|discord\\.gg)/[a-z0-9-]+/?(\\?.*)?$"
      ],
      "exclude": [],
      "enabled": true
    },
    {
      "id": "linear",
      "schemes": [
        "linear"
      ],
      "include": [
        "^https://linear\\.app/[^/]+/.*[?&]noRedirect=1(&|#|$)"
      ],
      "exclude": [
        "^https://linear\\.app/[^/]+/(settings|integrations)\\b"
      ],
      "enabled": true
    },
    {
      "id": "figma",
      "schemes": [
        "figma"
      ],
      "include": [
        "^https://(www\\.)?figma\\.com/(file|design|board|slides)/[a-z0-9]+"
      ],
      "exclude": [],
      "enabled": false
    },
    {
      "id": "spotify",
      "schemes": [
        "spotify"
      ],
      "include": [
        "^https://open\\.spotify\\.com/(intl-[a-z-]+/)?(track|album|playlist|episode|show|artist)/[a-z0-9]+"
      ],
      "exclude": [],
      "enabled": false
    }
  ].map(rule => ({
    ...rule,
    include: rule.include.map(pattern => new RegExp(pattern, "i")),
    exclude: rule.exclude.map(pattern => new RegExp(pattern, "i")),
  }));

  function appLauncherEnabled(rule) {
    return Services.prefs.getBoolPref(
      `extensions.littleZen.appLaunchers.${rule.id}`, rule.enabled
    );
  }

  function matchesAppLaunchPage(rule, spec) {
    return rule.include.some(pattern => pattern.test(spec)) &&
      !rule.exclude.some(pattern => pattern.test(spec));
  }

  // Zoom/Linear may add their completion marker just after native dispatch.
  // Recognize that pending handoff, but require the real marker before closing.
  function appLauncherCandidate(spec, scheme) {
    try {
      for (const rule of APP_LAUNCH_PRESETS) {
        if (!appLauncherEnabled(rule) || !rule.schemes.includes(scheme)) continue;
        const url = new URL(spec);
        if (rule.id === "zoom") url.hash = "success";
        if (rule.id === "linear") url.searchParams.set("noRedirect", "1");
        if (matchesAppLaunchPage(rule, url.href)) return rule;
      }
    } catch (error) {}
    return null;
  }

  function appLauncherNavigationKey(rule, spec) {
    const url = new URL(spec);
    if (rule.id === "zoom") url.hash = "";
    if (rule.id === "linear") url.searchParams.delete("noRedirect");
    // Teams updates these flags with history.pushState during its launch.
    // Keep the meeting URL and all other parameters significant.
    if (rule.id === "teams") {
      for (const key of ["suppressPrompt", "suppressAutoDownload", "promptSuccess"]) {
        url.searchParams.delete(key);
      }
    }
    return url.href;
  }

  function patchAppLaunchCleanup() {
    let prototype;
    try {
      ({ prototype } = ChromeUtils.importESModule(
        "resource://gre/modules/ContentDispatchChooser.sys.mjs"
      ).nsContentDispatchChooser);
    } catch (error) {
      log("App-launch cleanup unavailable", error);
      return;
    }
    if (prototype.__littleZenAppLaunchCleanupPatched) {
      return;
    }
    const originalHandleURI = prototype.handleURI;
    prototype.handleURI = async function (handler, uri, principal, context, ...rest) {
      // Launchers can dispatch the protocol from a hidden child frame.
      // Validate the containing page, not the child frame's transient URL.
      const browser = context?.topFrameElement;
      const win = browser?.ownerDocument?.defaultView;
      const source = browser?.currentURI?.spec;
      const rule = appLauncherCandidate(source, uri?.scheme);
      if (!Services.prefs.getBoolPref("extensions.littleZen.closeAppLaunchers", true) ||
          !isLittleWindow(win) ||
          browser !== win.gBrowser?.selectedBrowser ||
          !rule) {
        return originalHandleURI.call(this, handler, uri, principal, context, ...rest);
      }

      // handleURI resolves both on launch and on cancellation. Observe its
      // prompt result on a per-call receiver, without changing the shared
      // chooser instance or wrapping the native XPCOM handler object.
      let accepted = true;
      const chooser = Object.create(this);
      chooser._prompt = async (...args) => {
        accepted = false;
        const result = await this._prompt(...args);
        accepted = !!result;
        return result;
      };
      const documentId = browser.browsingContext?.currentWindowGlobal?.innerWindowId;
      const result = await originalHandleURI.call(
        chooser, handler, uri, principal, context, ...rest
      );
      // A web handler opens another website rather than a native application.
      const nativeHandler = handler.preferredAction === Ci.nsIHandlerInfo.useSystemDefault ||
        (handler.preferredAction === Ci.nsIHandlerInfo.useHelperApp &&
          !(handler.preferredApplicationHandler instanceof Ci.nsIWebHandlerApp));
      if (!accepted || !nativeHandler || win.closed) {
        log("App-launch cleanup: no native handoff", { app: rule.id, accepted, nativeHandler });
        return result;
      }
      log("App-launch cleanup armed", { app: rule.id, scheme: uri.scheme });
      win.clearTimeout(win.__littleZenAppLaunchCloseTimer);
      const delay = Math.max(500, Services.prefs.getIntPref(
        "extensions.littleZen.appLaunchCloseDelayMs", 1800
      ));
      const navigationKey = appLauncherNavigationKey(rule, source);
      const deadline = Date.now() + 10000;
      let readyAt = matchesAppLaunchPage(rule, source) ? Date.now() : null;
      const check = () => {
        delete win.__littleZenAppLaunchCloseTimer;
        if (win.closed || !isLittleWindow(win) ||
            !Services.prefs.getBoolPref("extensions.littleZen.closeAppLaunchers", true) ||
            !appLauncherEnabled(rule) || win.__littleZenTransferInProgress ||
            // Zen keeps a permanent blank tab for its start-page machinery.
            [...win.gBrowser.tabs].filter(tab =>
              tab !== win.gZenWorkspaces?._emptyTab && !tab.closing).length !== 1 ||
            win.gBrowser.selectedBrowser !== browser ||
            browser.browsingContext?.currentWindowGlobal?.innerWindowId !== documentId ||
            appLauncherNavigationKey(rule, browser.currentURI.spec) !== navigationKey) {
          log("App-launch cleanup canceled: page or window changed", { app: rule.id });
          return;
        }
        if (!matchesAppLaunchPage(rule, browser.currentURI.spec)) {
          if (readyAt !== null || Date.now() >= deadline) return;
        } else {
          readyAt ??= Date.now();
          if (Date.now() - readyAt >= delay) {
            // Preserve the native unload checks used by the close command.
            log("App-launch cleanup requesting close", { app: rule.id });
            win.__littleZenSuppressAppReturn = true;
            try { win.BrowserCommands.tryToCloseWindow(); }
            finally { if (!win.closed) delete win.__littleZenSuppressAppReturn; }
            return;
          }
        }
        win.__littleZenAppLaunchCloseTimer = win.setTimeout(check, 100);
      };
      // Allow Zen's initial container placeholder to finish closing first.
      win.__littleZenAppLaunchCloseTimer = win.setTimeout(check, delay);
      return result;
    };
    prototype.__littleZenAppLaunchCleanupPatched = true;
  }

  function patchBrowserWindowTracker() {
    if (BrowserWindowTracker[PATCH_FLAGS.browserWindowTracker]) {
      return;
    }

    const originalGetTopWindow = BrowserWindowTracker.getTopWindow.bind(
      BrowserWindowTracker
    );

    BrowserWindowTracker.getTopWindow = function (options = {}) {
      const topWindow = originalGetTopWindow(options);
      if (!topWindow || options.allowTaskbarTabs || !isLittleWindow(topWindow)) {
        return topWindow;
      }
      return getFallbackBrowserWindow(options) || topWindow;
    };

    BrowserWindowTracker[PATCH_FLAGS.browserWindowTracker] = true;
  }

  function patchUriLoadingHelper() {
    if (URILoadingHelper[PATCH_FLAGS.uriLoadingHelper]) {
      return;
    }

    const originalGetTargetWindow = URILoadingHelper.getTargetWindow.bind(
      URILoadingHelper
    );

    URILoadingHelper.getTargetWindow = function (currentWindow, options = {}) {
      const { top } = currentWindow;
      if (
        options.skipTaskbarTabs &&
        isBrowserWindow(top) &&
        isLittleWindow(top)
      ) {
        return (
          BrowserWindowTracker.getTopWindow({
            private:
              !options.forceNonPrivate &&
              PrivateBrowsingUtils.isWindowPrivate(currentWindow),
            allowPopups: !options.skipPopups,
            allowTaskbarTabs: false,
          }) || top
        );
      }

      const targetWindow = originalGetTargetWindow(currentWindow, options);
      if (options.skipTaskbarTabs && isLittleWindow(targetWindow)) {
        return (
          BrowserWindowTracker.getTopWindow({
            private:
              !options.forceNonPrivate &&
              PrivateBrowsingUtils.isWindowPrivate(currentWindow),
            allowPopups: !options.skipPopups,
            allowTaskbarTabs: false,
          }) || targetWindow
        );
      }

      return targetWindow;
    };

    URILoadingHelper[PATCH_FLAGS.uriLoadingHelper] = true;
    log("Patched URILoadingHelper.getTargetWindow");
  }

  function patchBrowserDOMWindow(win) {
    if (win[PATCH_FLAGS.browserDOMWindow]) {
      return;
    }

    const originalBrowserDOMWindow = win.browserDOMWindow;
    if (!originalBrowserDOMWindow) {
      log("Skipping browserDOMWindow patch; no browserDOMWindow on window yet");
      return;
    }

    const wrappedBrowserDOMWindow = {
      __proto__: originalBrowserDOMWindow,

      openURI(aURI, aOpener, aWhere, aContext, aTriggeringPrincipal, aCsp) {
        const url = aURI?.spec ?? null;
        const isExternal = isExternalOpenContext(aContext);
        log("browserDOMWindow.openURI", {
          url,
          where: aWhere,
          context: aContext,
          isExternal,
        });

        if (isExternal && url) {
          log("Intercepting external openURI into Little Zen", { url });
          LittleZen.openLittleWindow(win, {
            url,
            source: "browserDOMWindow.openURI",
            triggeringPrincipal: aTriggeringPrincipal,
          });
          return null;
        }

        return originalBrowserDOMWindow.openURI.call(
          originalBrowserDOMWindow,
          aURI,
          aOpener,
          aWhere,
          aContext,
          aTriggeringPrincipal,
          aCsp
        );
      },

      openURIInFrame(aURI, aParams, aWhere, aContext, aName) {
        const url = aURI?.spec ?? null;
        const isExternal = isExternalOpenContext(aContext);
        log("browserDOMWindow.openURIInFrame", {
          url,
          where: aWhere,
          context: aContext,
          isExternal,
          name: aName,
        });

        if (isExternal && url) {
          log("Intercepting external openURIInFrame into Little Zen", { url });
          LittleZen.openLittleWindow(win, {
            url,
            source: "browserDOMWindow.openURIInFrame",
          });
          return null;
        }

        return originalBrowserDOMWindow.openURIInFrame?.call(
          originalBrowserDOMWindow,
          aURI,
          aParams,
          aWhere,
          aContext,
          aName
        ) ?? null;
      },

      QueryInterface(iid) {
        if (
          iid.equals(Ci.nsIBrowserDOMWindow) ||
          iid.equals(Ci.nsISupports)
        ) {
          return this;
        }
        if (typeof originalBrowserDOMWindow.QueryInterface === "function") {
          return originalBrowserDOMWindow.QueryInterface(iid);
        }
        throw Components.Exception(
          "",
          Components.results.NS_ERROR_NO_INTERFACE
        );
      },
    };

    win._littleZenOriginalBrowserDOMWindow = originalBrowserDOMWindow;
    win.browserDOMWindow = wrappedBrowserDOMWindow;
    win[PATCH_FLAGS.browserDOMWindow] = true;
    log("Patched browserDOMWindow for external-link interception");
  }

  function patchOpenBrowserWindow(win) {
    if (win[PATCH_FLAGS.openBrowserWindow] || typeof win.OpenBrowserWindow !== "function") {
      return;
    }

    const originalOpenBrowserWindow = win.OpenBrowserWindow;

    win.OpenBrowserWindow = function (options = {}) {
      if (!options?.zenLittleWindow) {
        return originalOpenBrowserWindow.call(this, options);
      }

      const nextOptions = {
        ...options,
        all: options.all ?? false,
        features: options.features ?? OPEN_FEATURES,
        zenSyncedWindow: false,
      };

      const littleWindow = originalOpenBrowserWindow.call(this, nextOptions);
      if (littleWindow) {
        const sourceWindow = isLittleWindow(win) ? getMainBrowserWindow(win) : win;
        if (sourceWindow) {
          littleWindow.__littleZenSourceWindow = new WeakRef(sourceWindow);
        }
        markLittleWindowEarly(littleWindow, {
          url: options.url,
          expanded: options.expanded,
        });
        littleWindow._zenStartupSyncFlag = "unsynced";
        log("Opened Little Zen browser window", {
          startupSyncFlag: littleWindow._zenStartupSyncFlag,
          hasPendingUrl: !!littleWindow.__littleZenPendingURL,
        });
      }
      return littleWindow;
    };

    win[PATCH_FLAGS.openBrowserWindow] = true;
    log("Patched OpenBrowserWindow for Little Zen windows");
  }

  function patchCompactModeManager(win) {
    if (!win.__littleZenStartupReady) {
      return;
    }

    const manager = win.gZenCompactModeManager;
    if (!manager || manager[PATCH_FLAGS.compactMode]) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(manager, "shouldBeCompact");
    if (!descriptor?.get) {
      return;
    }

    Object.defineProperty(manager, "shouldBeCompact", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        if (win.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
          return false;
        }
        return descriptor.get.call(this);
      },
    });

    if (manager.preference) {
      manager.preference = false;
      log("Disabled inherited compact mode in Little Zen window");
    }

    manager[PATCH_FLAGS.compactMode] = true;
  }

  function patchVerticalTabsManager(win) {
    if (!win.__littleZenStartupReady) {
      return;
    }

    const manager = win.gZenVerticalTabsManager;
    if (!manager || manager[PATCH_FLAGS.verticalTabs]) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(manager, "hidesTabsToolbar");
    const originalGetter = descriptor?.get;
    const originalValue = originalGetter ? undefined : manager.hidesTabsToolbar;

    Object.defineProperty(manager, "hidesTabsToolbar", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        if (
          win.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR) ||
          win._zenStartupLittleWindow
        ) {
          return true;
        }
        return originalGetter ? originalGetter.call(this) : originalValue;
      },
    });

    if (typeof manager._updateEvent === "function") {
      const originalUpdateEvent = manager._updateEvent;
      manager._updateEvent = function (...args) {
        const root = win.document.documentElement;
        if (root.hasAttribute("zen-single-toolbar")) {
          this._hasSetSingleToolbar = true;
          this._navbarParent ||= this._toolbarOriginalParent;
        }
        const result = originalUpdateEvent.apply(this, args);
        root.removeAttribute("zen-single-toolbar");
        positionLittleWindowNavbar(win);
        return result;
      };
    }

    manager[PATCH_FLAGS.verticalTabs] = true;
  }

  function patchZenUIManager(win) {
    const manager = win.gZenUIManager;
    if (!manager || manager[PATCH_FLAGS.zenUIManager]) {
      return;
    }

    // Guard against closeWatermark firing before gZenUIManager.init() sets motion.
    // In the Little Zen window the async init races with delayedStartupFinished,
    // so we install a stub that silently no-ops until the real motion library loads.
    if (!manager.motion) {
      const noopAnimation = { finished: Promise.resolve(), complete: () => {}, cancel: () => {} };
      const noopFn = () => noopAnimation;
      const motionStub = {
        animate: noopFn,
        stagger: () => 0,
      };
      Object.defineProperty(manager, "motion", {
        configurable: true,
        enumerable: true,
        get() { return this._motion ?? motionStub; },
        set(v) {
          // Once the real motion library is assigned, replace the stub
          Object.defineProperty(manager, "motion", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: v,
          });
        },
      });
      log("Installed gZenUIManager.motion stub for Little Zen window");
    }

    if (typeof manager.onFloatingURLBarOpen === "function") {
      const originalOnFloatingURLBarOpen = manager.onFloatingURLBarOpen;
      manager.onFloatingURLBarOpen = function (...args) {
        const result = originalOnFloatingURLBarOpen.apply(this, args);
        win.requestAnimationFrame(() => {
          if (!isLittleWindow(win) || win.closed) {
            return;
          }

          win.dispatchEvent(new win.CustomEvent("ZenFloatingURLBarOpened"));
          logLittleWindowState(
            win,
            "Dispatched Little Zen floating-urlbar opened event"
          );
        });
        return result;
      };
    }

    manager[PATCH_FLAGS.zenUIManager] = true;
    log("Patched gZenUIManager for Little Zen lifecycle events");
  }

  function patchUrlbar(win) {
    const urlbar = win.gURLBar;
    if (!urlbar || urlbar[PATCH_FLAGS.urlbar]) {
      return;
    }

    const prototype = Object.getPrototypeOf(urlbar);
    const behaviorDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "zenUrlbarBehavior"
    );

    if (behaviorDescriptor?.get) {
      Object.defineProperty(urlbar, "zenUrlbarBehavior", {
        configurable: true,
        enumerable: behaviorDescriptor.enumerable,
        get() {
          if (this.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
            return "default";
          }
          return behaviorDescriptor.get.call(this);
        },
      });
    }

    if (typeof urlbar._whereToOpen === "function") {
      const originalWhereToOpen = urlbar._whereToOpen;
      urlbar._whereToOpen = function (event) {
        if (this.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
          return "current";
        }
        return originalWhereToOpen.call(this, event);
      };
    }

    urlbar._zenTrimURL = function (value) {
      return formatLittleZenUrlbarValue(value);
    };

    urlbar[PATCH_FLAGS.urlbar] = true;
  }

  function attachUrlbarDisableGuard(win) {
    if (!isBrowserWindow(win) || win[PATCH_FLAGS.urlbarDisableGuard]) {
      return;
    }

    const doc = win.document;
    const urlbar = win.gURLBar;
    const blockedEvents = [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "focusin",
      "beforeinput",
      "input",
    ];
    const listeners = [];

    const addListener = (target, type, listener) => {
      if (!target?.addEventListener) {
        return;
      }
      target.addEventListener(type, listener, true);
      listeners.push([target, type, listener]);
    };

    const isUrlbarButtonTarget = target => {
      if (!target?.closest) {
        return false;
      }
      try {
        return !!target.closest(
          [
            "#identity-box",
            "#tracking-protection-icon-container",
            "#page-action-buttons",
            "#urlbar-go-button",
            "#urlbar-revert-button",
            "#reader-mode-button",
            "#picture-in-picture-button",
            ".urlbar-page-action",
            "toolbarbutton",
            "button",
          ].join(",")
        );
      } catch (error) {
        return false;
      }
    };

    const isUrlbarInputTarget = target => {
      if (!target) {
        return false;
      }
      if (target === urlbar) {
        return true;
      }
      if (isUrlbarButtonTarget(target)) {
        return false;
      }
      if (!target.closest) {
        return false;
      }
      try {
        return !!target.closest(
          [
            "#urlbar-input",
            ".urlbar-input-box",
            ".urlbar-input-container",
            ".urlbar-background",
            "#urlbar-search-mode-indicator",
          ].join(",")
        );
      } catch (error) {
        return false;
      }
    };

    const isBlockedUrlbarTarget = event => {
      if (!urlbar || !event?.target) {
        return false;
      }
      try {
        return urlbar.contains(event.target) && isUrlbarInputTarget(event.target);
      } catch (error) {
        return false;
      }
    };

    const blockUrlbarOpen = (event, reason) => {
      if (!isLittleWindow(win)) {
        return;
      }

      try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
      } catch (error) {}

      closeLittleWindowUrlbar(win, reason);
    };

    const blockUrlbarTarget = event => {
      if (isBlockedUrlbarTarget(event)) {
        blockUrlbarOpen(event, `blocked-${event.type}`);
      }
    };

    const blockOpenLocationCommand = event => {
      blockUrlbarOpen(event, "blocked-open-location-command");
    };

    const blockOpenLocationKeys = event => {
      if (!isLittleWindow(win) || event.defaultPrevented) {
        return;
      }

      const key = event.key?.toLowerCase?.();
      const usesAccel = AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      if (
        (usesAccel && (key === "l" || key === "k" || key === "t")) ||
        (event.altKey && key === "d") ||
        event.key === "F6"
      ) {
        blockUrlbarOpen(event, `blocked-key-${event.key}`);
      }
    };

    for (const type of blockedEvents) {
      addListener(urlbar, type, blockUrlbarTarget);
    }
    addListener(doc.getElementById("Browser:OpenLocation"), "command", blockOpenLocationCommand);
    addListener(doc.getElementById("cmd_newNavigatorTab"), "command", event => {
      blockUrlbarOpen(event, "blocked-new-tab-command");
    });
    addListener(win, "keydown", blockOpenLocationKeys);

    try {
      urlbar?.setAttribute("zen-little-urlbar-disabled", "true");
    } catch (error) {}

    win.addEventListener(
      "unload",
      () => {
        for (const [target, type, listener] of listeners) {
          try {
            target.removeEventListener(type, listener, true);
          } catch (error) {}
        }
        try {
          urlbar?.removeAttribute("zen-little-urlbar-disabled");
        } catch (error) {}
      },
      { once: true }
    );

    win[PATCH_FLAGS.urlbarDisableGuard] = true;
    closeLittleWindowUrlbar(win, "urlbar-disable-guard-attached");
    log("Attached Little Zen urlbar disable guard");
  }

  function formatLittleZenUrlbarValue(value) {
    if (typeof value !== "string" || !value) {
      return value;
    }
    if (!Services.prefs.getBoolPref("browser.urlbar.trimURLs", false)) {
      return value;
    }

    let formatted = value;
    if (Services.prefs.getBoolPref("browser.urlbar.trimHttps", false)) {
      formatted = formatted.replace(/^https:\/\//i, "");
    }
    formatted = formatted.replace(/^http:\/\//i, "");

    try {
      const uri = new URL(value);
      if (
        formatted.endsWith("/") &&
        uri.pathname === "/" &&
        !uri.search &&
        !uri.hash
      ) {
        formatted = formatted.slice(0, -1);
      }
    } catch (error) {}

    return formatted;
  }

  function syncEmptyTabState(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return;
    }

    const root = win.document.documentElement;
    const tab = win.gBrowser?.selectedTab;

    if (win.__littleZenStartExpanded && tab?.hasAttribute("zen-empty-tab")) {
      tab.removeAttribute("zen-empty-tab");
    }

    const hasEmptyTab = usesEmptyLittleWindowPresentation(win);

    if (hasEmptyTab) {
      root.setAttribute("zen-has-empty-tab", "true");
    } else {
      root.removeAttribute("zen-has-empty-tab");
    }

    logLittleWindowState(win, "Synced Little Zen empty-tab state", { reason });
  }

  function leaveEmptyTabMode(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return;
    }

    const tab = win.gBrowser?.selectedTab;
    const urlbar = win.gURLBar;
    logLittleWindowState(win, "Leaving Little Zen empty-tab mode", { reason });

    if (tab?.hasAttribute("zen-empty-tab")) {
      tab.removeAttribute("zen-empty-tab");
    }

    try {
      urlbar?.removeAttribute("zen-newtab");
      urlbar?.removeAttribute("breakout-extend");
      urlbar?.removeAttribute("open");
      urlbar?.view?.close?.();
      urlbar?.inputField?.blur?.();
      urlbar?.blur?.();
    } catch (error) {
      log("Could not clear Little Zen zen-newtab attribute.", error);
    }

    syncEmptyTabState(win, `leave-empty-tab:${reason}`);
    refreshLittleWindowLayout(win);
  }

  function scheduleLeaveEmptyTabMode(win, reason = "unknown") {
    leaveEmptyTabMode(win, `${reason}:immediate`);
    win.requestAnimationFrame(() => {
      leaveEmptyTabMode(win, `${reason}:raf`);
    });
    win.setTimeout(() => {
      leaveEmptyTabMode(win, `${reason}:timeout`);
    }, 150);
  }

  function attachEmptyTabStateTracking(win) {
    if (win[PATCH_FLAGS.emptyState]) {
      return;
    }

    const scheduleThemeUpdate = (reason) => {
      updateLittleZenBlendedTheme(win, reason);
      win.setTimeout(() => updateLittleZenBlendedTheme(win, `${reason}:settled`), 180);
      win.setTimeout(() => updateLittleZenBlendedTheme(win, `${reason}:late`), 700);
    };

    const sync = event => {
      if (!isLittleWindow(win)) {
        return;
      }

      syncEmptyTabState(win, event?.type ?? "manual");
      scheduleThemeUpdate(event?.type ?? "manual");
      if (win.__littleZenPendingURL && win.__littleZenStartupReady) {
        flushPendingNavigation(win, `state-tracker:${event?.type ?? "manual"}`);
      }
    };

    const progressListener = {
      onLocationChange(browser, _webProgress, _request, _locationURI) {
        if (browser === win.gBrowser?.selectedBrowser) {
          scheduleThemeUpdate("location-change");
        }
      },

      onStateChange(browser, webProgress, _request, stateFlags) {
        if (
          browser === win.gBrowser?.selectedBrowser &&
          (webProgress?.isTopLevel ?? true) &&
          stateFlags & Ci.nsIWebProgressListener.STATE_STOP
        ) {
          scheduleThemeUpdate("state-stop");
          const currentSpec = browser.currentURI?.spec ?? "";
          if (
            stateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK &&
            !win.__littleZenPendingURL &&
            !isEmptyLittleWindow(win) &&
            currentSpec !== "about:blank"
          ) {
            setLittleWindowLoading(win, false, "state-stop");
          }
        }
      },
    };

    win.addEventListener("TabAttrModified", sync, true);
    win.addEventListener("TabSelect", sync, true);
    win.addEventListener("TabOpen", sync, true);
    win.addEventListener("TabClose", sync, true);
    try {
      win.gBrowser?.addTabsProgressListener?.(progressListener);
      win.addEventListener(
        "unload",
        () => {
          try {
            win.gBrowser?.removeTabsProgressListener?.(progressListener);
          } catch (error) {}
        },
        { once: true }
      );
    } catch (error) {
      log("Could not attach Little Zen theme progress listener", error);
    }
    win[PATCH_FLAGS.emptyState] = true;
    log("Attached Little Zen empty-tab state tracking");
  }

  function ensureLittleWindowLoadingPulse(win) {
    if (!isBrowserWindow(win)) {
      return null;
    }

    const doc = win.document;
    if (!doc.body) {
      return null;
    }

    let overlay = doc.getElementById("zen-little-window-loading-overlay");
    if (overlay) {
      return overlay;
    }

    overlay = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    overlay.id = "zen-little-window-loading-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const pulse = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    pulse.id = "zen-little-window-loading-pulse";
    overlay.appendChild(pulse);

    const fallback = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallback.id = "zen-little-window-load-fallback";

    const fallbackTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallbackTitle.id = "zen-little-window-load-fallback-title";
    fallbackTitle.textContent = "Still loading";
    fallback.appendChild(fallbackTitle);

    const fallbackActions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallbackActions.id = "zen-little-window-load-fallback-actions";

    const makeButton = (id, label, action) => {
      const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      button.id = id;
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      fallbackActions.appendChild(button);
      return button;
    };

    makeButton("zen-little-window-load-retry", "Retry", () => {
      retryLittleWindowStalledLoad(win);
    });
    makeButton("zen-little-window-load-main", "Open in Main", () => {
      openLittleWindowStalledLoadInMain(win);
    });
    makeButton("zen-little-window-load-close", "Close", () => {
      win.close();
    });

    fallback.appendChild(fallbackActions);
    overlay.appendChild(fallback);

    (doc.body || doc.documentElement).appendChild(overlay);
    return overlay;
  }

  function clearLittleWindowLoadingFallback(win) {
    try {
      if (win.__littleZenStalledLoadTimer) {
        win.clearTimeout(win.__littleZenStalledLoadTimer);
      }
    } catch (error) {}
    delete win.__littleZenStalledLoadTimer;

    try {
      win.document.documentElement.removeAttribute("zen-little-window-load-stalled");
      win.document
        .getElementById("zen-little-window-loading-overlay")
        ?.setAttribute("aria-hidden", "true");
    } catch (error) {}
  }

  function showLittleWindowStalledLoadFallback(win, reason = "unknown") {
    if (!isLittleWindow(win) || win.closed) {
      return;
    }

    const root = win.document.documentElement;
    if (!root.hasAttribute("zen-little-window-loading")) {
      return;
    }

    ensureLittleWindowLoadingPulse(win);
    root.setAttribute("zen-little-window-load-stalled", "true");
    win.document
      .getElementById("zen-little-window-loading-overlay")
      ?.removeAttribute("aria-hidden");
    logLittleWindowState(win, "Little Zen stalled-load fallback shown", {
      reason,
      timeoutMs: LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS,
    });
  }

  function scheduleLittleWindowLoadingFallback(win, reason = "unknown") {
    clearLittleWindowLoadingFallback(win);
    if (!isLittleWindow(win)) {
      return;
    }

    win.__littleZenStalledLoadTimer = win.setTimeout(() => {
      delete win.__littleZenStalledLoadTimer;
      showLittleWindowStalledLoadFallback(win, reason);
    }, LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS);
  }

  function getLittleWindowFallbackUrl(win) {
    return (
      win?.__littleZenPendingURL ||
      win?.__littleZenRoutedURL ||
      getLittleWindowUrl(win)
    );
  }

  function retryLittleWindowStalledLoad(win) {
    if (!isLittleWindow(win) || win.closed) {
      return;
    }

    const url = getLittleWindowFallbackUrl(win);
    clearLittleWindowLoadingFallback(win);
    setLittleWindowLoading(win, true, "stalled-retry");

    if (win.__littleZenPendingURL) {
      schedulePendingNavigationFlush(win, "stalled-retry");
      return;
    }

    try {
      if (url && url !== "about:blank") {
        win.gBrowser?.selectedBrowser?.reload?.();
      }
    } catch (error) {
      log("Could not retry stalled Little Zen load", error);
    }
  }

  function openLittleWindowStalledLoadInMain(win) {
    const url = getLittleWindowFallbackUrl(win);
    const mainWin = getMainBrowserWindow(win);
    if (!url || url === "about:blank" || !mainWin) {
      win.close();
      return;
    }

    try {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (typeof mainWin.openWebLinkIn === "function") {
        mainWin.openWebLinkIn(url, "tab", {
          triggeringPrincipal: principal,
          fromChrome: true,
        });
      } else {
        const tab = mainWin.gBrowser.addTab(url, {
          triggeringPrincipal: principal,
          skipAnimation: true,
        });
        if (tab) {
          mainWin.gBrowser.selectedTab = tab;
        }
      }
      mainWin.focus();
    } catch (error) {
      log("Could not open stalled Little Zen load in the main window", error);
    }

    win.close();
  }

  function setLittleWindowLoading(win, isLoading, reason = "unknown") {
    if (!isLittleWindow(win)) {
      return;
    }

    const root = win.document.documentElement;
    if (isLoading) {
      root.setAttribute("zen-little-window-loading", "true");
      ensureLittleWindowLoadingPulse(win);
      scheduleLittleWindowLoadingFallback(win, reason);
    } else {
      root.removeAttribute("zen-little-window-loading");
      clearLittleWindowLoadingFallback(win);
      delete win.__littleZenStartLoadingVeil;
      delete win.__littleZenSuppressUrlbarFocus;
      if (win.__littleZenReleasePresentationAfterLoading) {
        const releaseReason = win.__littleZenReleasePresentationAfterLoading;
        delete win.__littleZenReleasePresentationAfterLoading;
        releaseLittleWindowPresentation(win, `loading-complete:${releaseReason}`);
      }
    }

    logLittleWindowState(win, isLoading ? "Entered Little Zen loading veil" : "Left Little Zen loading veil", {
      reason,
    });
  }

  function positionLittleWindowNavbar(win) {
    const navBar = win.document.getElementById("nav-bar");
    const navContainer = win.document.getElementById(
      "zen-appcontent-navbar-container"
    );
    if (navBar && navContainer && navBar.parentElement !== navContainer) {
      navContainer.appendChild(navBar);
      log("Moved Little Zen navbar above page content");
    }

    const target = win.document.getElementById("nav-bar-customization-target");
    const urlbar = win.document.getElementById("urlbar-container");
    if (target && urlbar?.parentElement === target) {
      for (const id of ["back-button", "forward-button", "stop-reload-button"]) {
        const item = win.document.getElementById(id);
        if (item) {
          target.insertBefore(item, urlbar);
        }
      }
    }
  }

  function applyExpandedLittleWindow(win, reason) {
    if (!isBrowserWindow(win) || win.closed || win.__littleZenExpandedApplied) {
      return;
    }

    win.__littleZenExpandedApplied = true;
    win.__littleZenStartExpanded = true;
    closeLittleWindowUrlbar(win, "expanded-startup");
    leaveEmptyTabMode(win, reason);
    expandLittleWindow(win, reason);
  }

  function refreshLittleWindowLayout(win) {
    const root = win.document.documentElement;
    root.setAttribute(LITTLE_WINDOW_ATTR, "true");
    root.setAttribute("zen-compact-mode", "false");
    root.toggleAttribute("zen-no-padding", usesEmptyLittleWindowPresentation(win));

    try {
      win.ZenThemeModifier?.updateElementSeparation?.();
    } catch (error) {
      log("Could not refresh ZenThemeModifier.", error);
    }

    try {
      win.gZenVerticalTabsManager?._updateEvent?.();
    } catch (error) {
      log("Could not refresh vertical tabs layout.", error);
    }

    positionLittleWindowNavbar(win);
  }

  function verifyLittleWindowUrlbarPosition(win, reason = "unknown") {
    closeLittleWindowUrlbar(win, `urlbar-position-disabled:${reason}`);
  }

  function scheduleLittleWindowUrlbarPositionCheck(win, reason = "unknown") {
    closeLittleWindowUrlbar(win, `urlbar-position-check-disabled:${reason}`);
  }

  function openLittleWindowUrlbar(win) {
    closeLittleWindowUrlbar(win, "open-urlbar-disabled");
    logLittleWindowState(win, "Blocked Little Zen urlbar open");
    return false;
  }

  function closeLittleWindowUrlbar(win, reason = "unknown") {
    const urlbar = win?.gURLBar;
    if (!urlbar) {
      return;
    }

    try {
      urlbar.view?.close?.();
      urlbar.removeAttribute("zen-newtab");
      urlbar.removeAttribute("breakout-extend");
      urlbar.removeAttribute("open");
      urlbar.inputField?.blur?.();
      urlbar.blur?.();
      win.gBrowser?.selectedBrowser?.focus?.();
      logLittleWindowState(win, "Closed Little Zen urlbar for loaded navigation", {
        reason,
      });
    } catch (error) {
      log("Could not close Little Zen urlbar for loaded navigation.", error);
    }
  }

  function associateLittleWindowWithWorkspace(win, workspace) {
    if (!workspace?.uuid || !isLittleWindow(win)) {
      return;
    }
    const manager = win.gZenWorkspaces;
    // Little windows remain unsynced so their temporary tabs do not appear in
    // every main window. Give their local Space the real routed identity.
    if (!manager?.privateWindowOrDisabled) {
      throw new Error("Little Zen workspace association requires an unsynced window");
    }
    const previousId = manager.activeWorkspace;
    const section = manager.workspaceElement(previousId);
    const localWorkspace = structuredClone(workspace);
    manager._workspaceCache = [localWorkspace];
    if (section) {
      section.id = workspace.uuid;
      for (const element of section.querySelectorAll("[zen-workspace-id]")) {
        element.setAttribute("zen-workspace-id", workspace.uuid);
      }
      const label = section.querySelector(".zen-current-workspace-indicator-name");
      label?.setAttribute("value", workspace.name);
    }
    manager.activeWorkspace = workspace.uuid;
    for (const tab of win.gBrowser.tabs) {
      tab.setAttribute("zen-workspace-id", workspace.uuid);
    }
    win.__littleZenWorkspaceId = workspace.uuid;
    win.document.documentElement.setAttribute("zen-workspace-id", workspace.uuid);
    win.gBrowser.tabContainer._invalidateCachedTabs();
    routeLog("Associated Little Zen with routed workspace before loading", {
      workspaceId: workspace.uuid, workspaceName: workspace.name,
      containerTabId: workspace.containerTabId ?? 0,
    });
  }

  function flushPendingNavigation(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return false;
    }

    const pendingUrl = win.__littleZenPendingURL;
    if (!pendingUrl) {
      return false;
    }

    if (!win.__littleZenStartupReady) {
      logLittleWindowState(win, "Little Zen pending URL waiting for delayed startup", {
        reason,
        url: pendingUrl,
      });
      return false;
    }

    let selectedBrowser = win.gBrowser?.selectedBrowser;
    if (!selectedBrowser) {
      logLittleWindowState(win, "Little Zen pending URL waiting for selected browser", {
        reason,
        url: pendingUrl,
      });
      return false;
    }

    const pendingMeta = win.__littleZenPendingURLMeta ?? {};
    win.__littleZenSuppressUrlbarFocus = true;
    setLittleWindowLoading(win, true, `flush:${reason}`);
    closeLittleWindowUrlbar(win, `flush:${reason}`);
    delete win.__littleZenPendingURL;
    delete win.__littleZenPendingURLMeta;

    routeLog("Loading queued Little Zen URL", {
      url: pendingUrl,
      source: pendingMeta.source ?? "unknown",
      reason,
    });

    try {
      scheduleLeaveEmptyTabMode(win, `flush:${reason}`);

      const principal =
        pendingMeta.triggeringPrincipal ||
        Services.scriptSecurityManager.getSystemPrincipal();
      const mainWin = getMainBrowserWindow(win);
      const routingDecision = mainWin
        ? resolveLittleZenRoutingDecision(
            win,
            mainWin,
            pendingUrl,
            principal,
            `flush:${reason}`
          )
        : null;
      const targetWorkspace = routingDecision?.targetWorkspace ?? null;
      const targetContainerId = routingDecision?.targetContainerId ?? 0;
      associateLittleWindowWithWorkspace(win, targetWorkspace);
      const selectedTab = win.gBrowser?.selectedTab;
      const currentContainerId = getTabContainerId(selectedTab);

      routeLog("Little Zen routing target: preparing tab container before load", {
        url: pendingUrl,
        reason,
        targetWorkspaceId: targetWorkspace?.uuid ?? null,
        targetWorkspaceName: targetWorkspace?.name ?? null,
        targetContainerId,
        currentContainerId,
      });

      let loadedByNewTab = false;
      if (selectedTab && currentContainerId !== targetContainerId) {
        const routedTabOptions = {
          triggeringPrincipal: principal,
          skipAnimation: true,
          skipRoute: true,
          inBackground: false,
        };
        if (targetContainerId) {
          routedTabOptions.userContextId = targetContainerId;
        }
        const routedTab = win.gBrowser.addTab(pendingUrl, routedTabOptions);

        if (routedTab?.linkedBrowser) {
          loadedByNewTab = true;
          syncLittleWindowTransparentBrowsers(win);
          win.gBrowser.selectedTab = routedTab;
          selectedBrowser = routedTab.linkedBrowser;
          win.setTimeout(() => {
            try {
              if (
                selectedTab !== routedTab &&
                win.gBrowser.selectedTab === routedTab &&
                routedTab.linkedBrowser &&
                selectedTab?.parentNode &&
                !selectedTab.closing &&
                win.gBrowser.tabs.length > 1
              ) {
                win.gBrowser.removeTab(selectedTab, { animate: false });
              }
            } catch (error) {
              log("Could not remove old Little Zen container placeholder tab", error);
            }
          }, 1000);
          routeLog("Little Zen routing target: opened routed URL in target container tab", {
            targetContainerId,
            targetWorkspaceId: targetWorkspace?.uuid ?? null,
          });
        } else {
          log("Little Zen routing target: routed container tab creation failed", {
            targetContainerId,
            targetWorkspaceId: targetWorkspace?.uuid ?? null,
          });
          win.__littleZenPendingURL = pendingUrl;
          win.__littleZenPendingURLMeta = pendingMeta;
          setLittleWindowLoading(win, true, `retry:${reason}`);
          return false;
        }
      } else if (selectedTab && targetWorkspace?.uuid) {
        syncLittleWindowTransparentBrowsers(win);
      }

      const loadFlags =
        Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP ??
        Ci.nsIWebNavigation.LOAD_FLAGS_NONE;

      if (!loadedByNewTab) {
        selectedBrowser.browsingContext.loadURI(Services.io.newURI(pendingUrl), {
          triggeringPrincipal: principal,
          loadFlags,
        });
      }

      try {
        win.__littleZenRefreshSpacePickerTarget?.();
      } catch (error) {
        log("Could not refresh Little Zen routed workspace after dispatch", error);
      }
      updateLittleZenBlendedTheme(win, `dispatch:${reason}`);

      win.setTimeout(() => {
        expandLittleWindow(win, `pending-navigation:${reason}`);
        try {
          win.__littleZenRefreshSpacePickerTarget?.();
        } catch (error) {
          log("Could not refresh Little Zen routed workspace after expand", error);
        }
      }, 0);

      logLittleWindowState(win, "Queued Little Zen URL dispatched", {
        url: pendingUrl,
        source: pendingMeta.source ?? "unknown",
        reason,
      });
      return true;
    } catch (error) {
      log("Failed to load queued Little Zen URL", pendingUrl, error);
      win.__littleZenPendingURL = pendingUrl;
      win.__littleZenPendingURLMeta = pendingMeta;
      setLittleWindowLoading(win, true, `error:${reason}`);
      return false;
    }
  }

  function schedulePendingNavigationFlush(win, reason = "unknown") {
    if (!win?.__littleZenPendingURL || win.closed) {
      return;
    }

    logLittleWindowState(win, "Scheduling Little Zen pending navigation flush", {
      reason,
      url: win.__littleZenPendingURL,
    });

    const attemptFlush = phase => {
      if (win.closed || !win.__littleZenPendingURL) {
        return;
      }
      flushPendingNavigation(win, `${reason}:${phase}`);
    };

    attemptFlush("immediate");
    win.requestAnimationFrame(() => {
      attemptFlush("raf");
    });
    win.setTimeout(() => {
      attemptFlush("timeout-150");
    }, 150);
    win.setTimeout(() => {
      attemptFlush("timeout-500");
    }, 500);
  }

  function getMacWindowFocusBridge() {
    const key = "__littleZenMacWindowFocusBridge";
    if (key in BrowserWindowTracker) return BrowserWindowTracker[key];
    try {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const services = ctypes.open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
      const pointer = ctypes.voidptr_t;
      const getClass = objc.declare("objc_getClass", ctypes.default_abi, pointer, ctypes.char.ptr);
      const selector = objc.declare("sel_registerName", ctypes.default_abi, pointer, ctypes.char.ptr);
      const message = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, pointer, pointer);
      const messageObject = objc.declare("objc_msgSend", ctypes.default_abi, pointer, pointer, pointer);
      const messageBool = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.bool, pointer, pointer);
      const serial = ctypes.StructType("LittleZenProcessSerialNumber", [
        { highLongOfPSN: ctypes.uint32_t }, { lowLongOfPSN: ctypes.uint32_t },
      ]);
      const getProcess = services.declare("GetCurrentProcess", ctypes.default_abi, ctypes.int16_t, serial.ptr);
      const setFront = services.declare("SetFrontProcessWithOptions", ctypes.default_abi, ctypes.int32_t, serial.ptr, ctypes.uint32_t);
      const process = serial();
      if (getProcess(process.address()) !== 0) throw new Error("Could not identify Zen process");
      const orderFront = selector("orderFrontRegardless");
      const makeKey = selector("makeKeyWindow");
      const isVisible = selector("isVisible");
      const app = messageObject(getClass("NSApplication"), selector("sharedApplication"));
      const isActive = selector("isActive");
      const frontWindowOnly = 1; // kSetFrontProcessFrontWindowOnly
      const workspace = messageObject(getClass("NSWorkspace"), selector("sharedWorkspace"));
      const runningAppClass = getClass("NSRunningApplication");
      const getPid = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.int32_t, pointer, pointer);
      const getAppForPid = objc.declare("objc_msgSend", ctypes.default_abi, pointer, pointer, pointer, ctypes.int32_t);
      const dateValue = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.double, pointer, pointer);
      const getProcessForPid = services.declare("GetProcessForPID", ctypes.default_abi, ctypes.int16_t, ctypes.int32_t, serial.ptr);
      const frontmostApp = selector("frontmostApplication");
      const processId = selector("processIdentifier");
      const launchDate = selector("launchDate");
      const dateSeconds = selector("timeIntervalSince1970");
      const appForPid = selector("runningApplicationWithProcessIdentifier:");
      const isTerminated = selector("isTerminated");
      const isKeyWindow = selector("isKeyWindow");
      const core = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
      const copyWindows = services.declare("CGWindowListCopyWindowInfo", ctypes.default_abi, pointer, ctypes.uint32_t, ctypes.uint32_t);
      const arrayCount = core.declare("CFArrayGetCount", ctypes.default_abi, ctypes.long, pointer);
      const arrayItem = core.declare("CFArrayGetValueAtIndex", ctypes.default_abi, pointer, pointer, ctypes.long);
      const dictionaryItem = core.declare("CFDictionaryGetValue", ctypes.default_abi, pointer, pointer, pointer);
      const makeString = core.declare("CFStringCreateWithCString", ctypes.default_abi, pointer, pointer, ctypes.char.ptr, ctypes.uint32_t);
      const readNumber = core.declare("CFNumberGetValue", ctypes.default_abi, ctypes.bool, pointer, ctypes.int, ctypes.int32_t.ptr);
      const release = core.declare("CFRelease", ctypes.default_abi, ctypes.void_t, pointer);
      const numberKey = makeString(null, "kCGWindowNumber", 0x08000100);
      const layerKey = makeString(null, "kCGWindowLayer", 0x08000100);
      const windowNumber = selector("windowNumber");
      const getNumber = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.long, pointer, pointer);
      const orderRelative = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, pointer, pointer, ctypes.long, ctypes.long);
      const orderWindow = selector("orderWindow:relativeTo:");
      const { setInterval, clearInterval, setTimeout: delayTask } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      let tracking = false;
      let inactiveOrder = null;
      let pendingRestore = null;
      const nativeWindowFor = win => {
        const handle = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
        return !handle || /^0x0+$/.test(handle) ? null : pointer(ctypes.UInt64(handle));
      };
      const appIdentity = runningApp => {
        if (runningApp.isNull() || messageBool(runningApp, isTerminated)) return null;
        const pid = getPid(runningApp, processId);
        if (pid === Services.appinfo.processID) return null;
        const date = messageObject(runningApp, launchDate);
        if (date.isNull()) return null;
        return { pid, launched: dateValue(date, dateSeconds) };
      };
      const foregroundApp = () => appIdentity(messageObject(workspace, frontmostApp));
      const returns = new Map();
      const snapshotOrder = () => {
        // Read only window IDs and levels, never other apps' titles or content.
        const array = copyWindows(1 | 16, 0); // on-screen, excluding desktop
        if (array.isNull()) return [];
        try {
          const result = [];
          const value = ctypes.int32_t();
          for (let i = 0; i < Number(arrayCount(array).toString()); i++) {
            const entry = arrayItem(array, i);
            const layer = dictionaryItem(entry, layerKey);
            if (layer.isNull() || !readNumber(layer, 3, value.address()) || value.value !== 0) continue;
            const number = dictionaryItem(entry, numberKey);
            if (!number.isNull() && readNumber(number, 3, value.address())) result.push(value.value);
          }
          return result;
        } finally { release(array); }
      };
      const restoreOrder = (snapshot, exceptWindow) => {
        const live = new Set(snapshotOrder());
        const own = new Map();
        for (const win of browserWindows()) {
          if (win === exceptWindow || win.closed) continue;
          const native = nativeWindowFor(win);
          if (!native || !messageBool(native, isVisible)) continue;
          const number = Number(getNumber(native, windowNumber).toString());
          if (live.has(number)) own.set(number, native);
        }
        const order = snapshot.filter(number => live.has(number));
        let below = null;
        for (let i = order.length - 1; i >= 0; i--) {
          const number = order[i];
          const native = own.get(number);
          if (native) {
            if (below !== null) {
              orderRelative(native, orderWindow, 1, below); // above its old neighbor
            } else {
              const above = order.slice(0, i).reverse().find(id => !own.has(id));
              if (above !== undefined) orderRelative(native, orderWindow, -1, above);
            }
          }
          below = number;
        }
      };
      const activateLauncher = (entry, phase) => {
        if (Services.startup.shuttingDown ||
            !Services.prefs.getBoolPref("extensions.littleZen.returnToSourceApp", true) ||
            !messageBool(app, isActive)) return false;
        const running = getAppForPid(runningAppClass, appForPid, entry.sourceApp.pid);
        const identity = appIdentity(running);
        if (!identity || identity.launched !== entry.sourceApp.launched) return false;
        const sourceProcess = serial();
        if (getProcessForPid(identity.pid, sourceProcess.address()) !== 0) return false;
        restoreOrder(entry.armed, null);
        if (setFront(sourceProcess.address(), frontWindowOnly) !== 0) return false;
        log("Returned focus to Little Zen launcher", { phase });
        return true;
      };
      const bridge = {
        // Keep the libraries/types alive while their declared functions are used.
        objc, services, core, ctypes, snapshotOrder,
        rememberLauncher(win, context) {
          returns.delete(win);
          if (!context?.sourceApp) return;
          returns.set(win, { sourceApp: context.sourceApp, armed: null });
          log("Remembered Little Zen launching app");
        },
        prepareReturn(win) {
          const entry = returns.get(win);
          if (!entry) return;
          entry.armed = null;
          if (Services.startup.shuttingDown || win.__littleZenTransferInProgress || win.__littleZenSuppressAppReturn ||
              !Services.prefs.getBoolPref("extensions.littleZen.returnToSourceApp", true) ||
              !messageBool(app, isActive)) return;
          const native = nativeWindowFor(win);
          if (native && messageBool(native, isKeyWindow)) {
            entry.armed = snapshotOrder();
            log("Prepared Little Zen launcher return");
            if (Services.prefs.getBoolPref("extensions.littleZen.returnBeforeClose", true)) {
              const sequence = entry.armed;
              // FinalClose marks the outer window closed before its posted
              // native destruction. This task runs in that gap. A canceled
              // DOMWindowClose leaves win.closed false, so focus stays put.
              Services.tm.dispatchToMainThread(() => {
                if (!win.closed || entry.armed !== sequence ||
                    win.__littleZenTransferInProgress || win.__littleZenSuppressAppReturn) return;
                try { activateLauncher(entry, "before-native-close"); }
                catch (error) { log("Early Little Zen app return failed", error); }
              });
            }
          }
        },
        startTracking() {
          if (tracking) return;
          tracking = true;
          // A URL AppleEvent can activate all Zen windows before JS sees it.
          // Keep a short-lived, in-memory order snapshot while Zen is inactive.
          const timer = setInterval(() => {
            try {
              if ((Services.prefs.getBoolPref("extensions.littleZen.focusWindowOnly", true) ||
                   Services.prefs.getBoolPref("extensions.littleZen.returnToSourceApp", true)) &&
                  !messageBool(app, isActive)) {
                inactiveOrder = { at: Date.now(), order: snapshotOrder(), sourceApp: foregroundApp() };
              }
            } catch (error) {
              clearInterval(timer);
              tracking = false;
              inactiveOrder = null;
              log("Could not snapshot macOS window order", error);
            }
          }, 250);
        },
        noteExternalOpen() {
          if (!inactiveOrder || Date.now() - inactiveOrder.at > 2000) return;
          if (Services.prefs.getBoolPref("extensions.littleZen.focusWindowOnly", true)) {
            pendingRestore = { expires: Date.now() + 3000, order: inactiveOrder.order };
            restoreOrder(pendingRestore.order, null);
            log("Restored Zen window order after external activation");
          }
          return { sourceApp: inactiveOrder.sourceApp };
        },
        raise(win) {
          const nativeWindow = nativeWindowFor(win);
          if (!nativeWindow) return false;
          if (!messageBool(nativeWindow, isVisible)) return false;
          if (pendingRestore) {
            const snapshot = pendingRestore;
            pendingRestore = null;
            if (Date.now() <= snapshot.expires) restoreOrder(snapshot.order, win);
          }
          // Raise the requested window at its normal level, without changing
          // geometry, minimization, or other applications' window ordering.
          message(nativeWindow, orderFront);
          if (!messageBool(app, isActive) && setFront(process.address(), frontWindowOnly) !== 0) {
            throw new Error("macOS refused single-window activation");
          }
          message(nativeWindow, makeKey);
          return true;
        },
      };
      Services.obs.addObserver({ observe() {
        // The observer supplies an XPCOM window wrapper, which need not be the
        // same JS object used as the map key. Check our tracked outer windows.
        for (const [win, entry] of returns) {
          if (!win.closed) continue;
          returns.delete(win);
          if (!entry.armed) continue;
          // Fallback for close paths whose native destruction wins the race.
          // If early handoff succeeded, Zen is no longer active and this is a no-op.
          delayTask(() => {
            try { activateLauncher(entry, "after-native-close-fallback"); }
            catch (error) { log("Could not return focus to Little Zen launcher", error); }
          }, 50);
        }
      }}, "domwindowclosed");
      BrowserWindowTracker[key] = bridge;
      return bridge;
    } catch (error) {
      log("Single-window macOS activation unavailable", error);
      BrowserWindowTracker[key] = null;
      return null;
    }
  }

  function attachMacWindowOrderTracking(win) {
    if (AppConstants.platform !== "macosx") return;
    whenStartupReady(win, () => {
      try {
        const handle = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
        if (handle && !/^0x0+$/.test(handle)) getMacWindowFocusBridge()?.startTracking();
      } catch (error) { log("Could not track macOS window order", error); }
    });
  }

  function attachLittleWindowAppReturn(win) {
    if (AppConstants.platform !== "macosx" || win.__littleZenAppReturnAttached) return;
    win.__littleZenAppReturnAttached = true;
    win.addEventListener("DOMWindowClose", event => {
      if (event.target !== win && event.target !== win.document) return;
      try { getMacWindowFocusBridge()?.prepareReturn?.(win); }
      catch (error) { log("Could not prepare Little Zen app return", error); }
    });
  }

  function focusLittleWindow(win) {
    if (!win || win.closed) return;
    if (AppConstants.platform === "macosx" && isLittleWindow(win) &&
        Services.prefs.getBoolPref("extensions.littleZen.focusWindowOnly", true)) {
      const bridge = getMacWindowFocusBridge();
      if (bridge) {
        try {
          if (!bridge.raise(win) && !win.__littleZenStartupReady &&
              (win.__littleZenFocusRetries ?? 0) < 40) {
            // A newly created chrome window still has its initial document.
            // Wait until it has a visible native window instead of activating
            // Zen's previous main window while this one is being constructed.
            if (!win.__littleZenFocusRetry) {
              win.__littleZenFocusRetries = (win.__littleZenFocusRetries ?? 0) + 1;
              win.__littleZenFocusRetry = win.setTimeout(() => {
                delete win.__littleZenFocusRetry;
                focusLittleWindow(win);
              }, 50);
            }
            return;
          }
        } catch (error) {
          log("Could not activate only Little Zen", error);
        }
      }
    }
    win.clearTimeout(win.__littleZenFocusRetry);
    delete win.__littleZenFocusRetry;
    delete win.__littleZenFocusRetries;
    // With the process already active, update Gecko's focus bookkeeping too.
    win.focus();
  }

  function focusUrlbar(win) {
    try {
      focusLittleWindow(win);
      win.gURLBar?.focus();
      win.gURLBar?.select();
      win.gURLBar?.inputField?.focus();
    } catch (error) {
      log("Could not focus the Little Zen urlbar.", error);
    }
  }

  // ── Workspace Picker ────────────────────────────────────────────────────────

  const PICKER_ID = "zen-little-window-space-picker";
  const PICKER_MENU_ID = "zen-little-window-space-menu";

  function getMainBrowserWindow(win) {
    const sourceWindow = win?.__littleZenSourceWindow?.deref?.();
    const candidates = [sourceWindow, ...BrowserWindowTracker.orderedWindows, ...browserWindows()]
      .filter((bw, index, all) => bw && all.indexOf(bw) === index &&
        isBrowserWindow(bw) && !isLittleWindow(bw) && bw !== win &&
        bw.toolbar?.visible && !bw.document.documentElement.hasAttribute("taskbartab") &&
        PrivateBrowsingUtils.isWindowPrivate(bw) === PrivateBrowsingUtils.isWindowPrivate(win));
    // Blank/unsynced windows have their own placeholder Space. They cannot
    // resolve routes into the user's normal synced Spaces.
    const synced = candidates.filter(bw => bw.gZenStartup?.isReady &&
      bw.gZenWorkspaces?.workspaceEnabled && !bw.gZenWorkspaces.privateWindowOrDisabled);
    const url = getLittleWindowRouteUrl(win);
    if (url) {
      const routed = synced.find(bw => {
        try {
          const route = bw.gZenSpaceRoutingManager?.routeUri?.(url, { fromExternal: true });
          return !!getWorkspaceByRouteTarget(bw, route);
        } catch (error) {
          return false;
        }
      });
      if (routed) {
        return routed;
      }
    }
    return synced[0] ?? candidates[0] ?? null;
  }

  function getWorkspaces(mainWin) {
    try {
      return mainWin?.gZenWorkspaces?.getWorkspaces?.() ?? [];
    } catch (e) {
      return [];
    }
  }

  function getActiveWorkspaceId(mainWin) {
    try {
      return mainWin?.gZenWorkspaces?.getActiveWorkspace?.()?.uuid ?? null;
    } catch (e) {
      return null;
    }
  }

  function getWorkspaceById(mainWin, id) {
    try {
      return mainWin?.gZenWorkspaces?.getWorkspaceFromId?.(id) ?? null;
    } catch (e) {
      return null;
    }
  }

  function getWorkspaceByRouteTarget(mainWin, routeTarget) {
    if (!routeTarget || routeTarget === "most-recent-space") {
      return null;
    }

    const directMatch = getWorkspaceById(mainWin, routeTarget);
    if (directMatch) {
      return directMatch;
    }

    const normalizedTarget = String(routeTarget).toLowerCase();
    return (
      getWorkspaces(mainWin).find((workspace) => {
        return (
          workspace?.uuid === routeTarget ||
          workspace?.id === routeTarget ||
          String(workspace?.name ?? "").toLowerCase() === normalizedTarget
        );
      }) ?? null
    );
  }

  function getWorkspaceContainerId(workspace) {
    const containerId = Number.parseInt(workspace?.containerTabId ?? 0, 10);
    return Number.isFinite(containerId) ? containerId : 0;
  }

  function getTabContainerId(tab) {
    const containerId = Number.parseInt(tab?.getAttribute("usercontextid") ?? 0, 10);
    return Number.isFinite(containerId) ? containerId : 0;
  }

  function getOpenShortcutDisplay() {
    return AppConstants.platform === "macosx" ? "⌘O" : "Ctrl+O";
  }

  function getWorkspaceDisplayIcon(workspace) {
    if (workspace?.icon) {
      return workspace.icon;
    }

    const name = String(workspace?.name ?? "Space");
    try {
      return new Intl.Segmenter().segment(name).containing(0).segment.toUpperCase();
    } catch (error) {
      return Array.from(name)[0]?.toUpperCase() ?? "S";
    }
  }

  function isTransparentBrowserAllowed() {
    try {
      return Services.prefs.getBoolPref(
        "browser.tabs.allow_transparent_browser",
        false
      );
    } catch (error) {
      return false;
    }
  }

  function syncLittleWindowTransparentBrowsers(win) {
    if (!isLittleWindow(win)) {
      return;
    }

    const enabled = isTransparentBrowserAllowed();
    win.document.documentElement.toggleAttribute(
      "zen-little-window-transparent-browser",
      enabled
    );

    try {
      for (const browser of win.gBrowser?.browsers ?? []) {
        if (enabled) {
          browser.setAttribute("transparent", "true");
        } else {
          browser.removeAttribute("transparent");
        }
      }
    } catch (error) {
      log("Could not sync Little Zen transparent browser attribute", error);
    }
  }

  function attachTransparentBrowserPrefSync(win) {
    if (win.__littleZenTransparentPrefSyncAttached) {
      return;
    }
    win.__littleZenTransparentPrefSyncAttached = true;

    const observer = () => syncLittleWindowTransparentBrowsers(win);
    try {
      Services.prefs.addObserver(
        "browser.tabs.allow_transparent_browser",
        observer
      );
      win.addEventListener(
        "unload",
        () => {
          try {
            Services.prefs.removeObserver(
              "browser.tabs.allow_transparent_browser",
              observer
            );
          } catch (error) {}
        },
        { once: true }
      );
    } catch (error) {
      log("Could not attach Little Zen transparent browser pref observer", error);
    }
  }

  function attachLittleWindowCloseButtonGuard(win) {
    if (win.__littleZenCloseButtonGuardAttached) {
      return;
    }
    win.__littleZenCloseButtonGuardAttached = true;

    const isCloseButtonTarget = (target) =>
      !!(
        target?.classList?.contains("titlebar-close") ||
        target?.closest?.(".titlebar-close")
      );

    const closeFromTitlebar = (event) => {
      const closeButton =
        event.composedPath?.().some(isCloseButtonTarget) ||
        isCloseButtonTarget(event.target);
      if (!closeButton || !isLittleWindow(win)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        win.close();
      } catch (error) {
        log("Little Zen titlebar close guard failed", error);
      }
    };

    win.addEventListener("mousedown", closeFromTitlebar, true);
    win.addEventListener("click", closeFromTitlebar, true);
    win.addEventListener("command", closeFromTitlebar, true);
    win.addEventListener(
      "unload",
      () => {
        try {
          win.removeEventListener("mousedown", closeFromTitlebar, true);
          win.removeEventListener("click", closeFromTitlebar, true);
          win.removeEventListener("command", closeFromTitlebar, true);
        } catch (error) {}
      },
      { once: true }
    );
  }

  function rgbaToCss(color) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a.toFixed(3)})`;
  }

  function rgbToCss(color) {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function parseCssRgb(input) {
    if (!input) {
      return null;
    }
    const raw = String(input).trim();
    const perceptual = raw.match(/^ok(?:lab|lch)\(\s*(\d+(?:\.\d+)?%?)/i);
    if (perceptual) {
      const channel = perceptual[1];
      const lightness = channel.endsWith("%")
        ? parseFloat(channel) / 100
        : parseFloat(channel);
      if (Number.isFinite(lightness)) {
        const value = Math.max(0, Math.min(255, Math.round(lightness * 255)));
        return { r: value, g: value, b: value };
      }
    }

    const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      const value = hex[1];
      const expand = (part) => part.length === 1 ? `${part}${part}` : part;
      const r = parseInt(expand(value.length <= 4 ? value[0] : value.slice(0, 2)), 16);
      const g = parseInt(expand(value.length <= 4 ? value[1] : value.slice(2, 4)), 16);
      const b = parseInt(expand(value.length <= 4 ? value[2] : value.slice(4, 6)), 16);
      return { r, g, b };
    }

    const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (!rgb) {
      return null;
    }
    const parts = rgb[1].replace(/\s*\/\s*[\d.]+%?$/, "").split(/[,\s]+/).filter(Boolean);
    if (parts.length < 3) {
      return null;
    }
    const readChannel = (part) => {
      const value = parseFloat(part);
      const scaled = String(part).trim().endsWith("%") ? value * 2.55 : value;
      return Math.max(0, Math.min(255, Math.round(scaled)));
    };
    return {
      r: readChannel(parts[0]),
      g: readChannel(parts[1]),
      b: readChannel(parts[2]),
    };
  }

  function getCssColorAlpha(value) {
    const match = String(value || "").trim().match(/^[a-z-]+\(([^)]+)\)$/i);
    if (!match) {
      return null;
    }

    const body = match[1].trim();
    let alpha = null;
    if (body.includes("/")) {
      alpha = body.slice(body.lastIndexOf("/") + 1).trim();
    } else {
      const parts = body.split(",");
      if (parts.length === 4) {
        alpha = parts[3].trim();
      }
    }
    if (alpha === null) {
      return null;
    }

    const amount = parseFloat(alpha);
    if (!Number.isFinite(amount)) {
      return null;
    }
    return alpha.endsWith("%") ? amount / 100 : amount;
  }

  function hasVisibleColor(input) {
    if (!input) {
      return false;
    }
    const value = String(input).trim().toLowerCase();
    if (!value || value === "transparent") {
      return false;
    }
    const alpha = getCssColorAlpha(value);
    return alpha === null || alpha >= 0.08;
  }

  function extractCssColor(input) {
    const value = String(input || "").trim();
    if (!value || value === "none") {
      return null;
    }
    const candidates = value.match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || [];
    return candidates.find(hasVisibleColor) || null;
  }

  function getStyleBackground(style) {
    if (!style) {
      return null;
    }
    if (hasVisibleColor(style.backgroundColor)) {
      return style.backgroundColor;
    }
    return extractCssColor(style.backgroundImage);
  }

  function getRelativeLuminance(color) {
    const toLinear = (channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * toLinear(color.r) +
      0.7152 * toLinear(color.g) +
      0.0722 * toLinear(color.b)
    );
  }

  function getContrastRatio(a, b) {
    const light = Math.max(getRelativeLuminance(a), getRelativeLuminance(b));
    const dark = Math.min(getRelativeLuminance(a), getRelativeLuminance(b));
    return (light + 0.05) / (dark + 0.05);
  }

  function chooseForeground(color) {
    return getRelativeLuminance(color) > 0.6
      ? "rgba(11, 13, 16, 0.92)"
      : "rgba(245, 247, 251, 0.96)";
  }

  function getReadableForeground(bg, candidates = []) {
    const bgRgb = parseCssRgb(bg);
    if (!bgRgb) {
      return candidates.find(hasVisibleColor) || "currentColor";
    }
    return candidates.find((candidate) => {
      const fgRgb = parseCssRgb(candidate);
      if (!fgRgb) {
        return false;
      }
      return getContrastRatio(bgRgb, fgRgb) >= 4.5;
    }) || chooseForeground(bgRgb);
  }

  function getStableHeaderForeground(bgRgb, foreground) {
    const fgRgb = parseCssRgb(foreground);
    if (fgRgb && getContrastRatio(bgRgb, fgRgb) >= 4.5) {
      return foreground;
    }
    return chooseForeground(bgRgb);
  }

  function getCurrentThemeColorScheme(win) {
    const themeWin = isLittleWindow(win) ? getMainBrowserWindow(win) || win : win;
    const root = themeWin.document.documentElement;
    const style = themeWin.getComputedStyle(root);
    const scheme = String(style.getPropertyValue("--toolbar-color-scheme") || style.colorScheme || "")
      .trim().toLowerCase();
    if (scheme === "light" || scheme === "dark") {
      return scheme;
    }
    return root.hasAttribute("zen-should-be-dark-mode") ||
      themeWin.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getNeutralHeaderShade(win, source = "unknown-page") {
    const isLight = getCurrentThemeColorScheme(win) === "light";
    return {
      bg: isLight ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)",
      fg: isLight ? "rgba(11, 13, 16, 0.82)" : "rgba(245, 247, 251, 0.9)",
      source,
    };
  }

  function getThemeColorTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) {
      return null;
    }

    const metas = doc.querySelectorAll?.('meta[name="theme-color" i]') || [];
    for (const meta of metas) {
      const media = meta.getAttribute?.("media") || "";
      if (media) {
        try {
          if (!view.matchMedia(media).matches) {
            continue;
          }
        } catch (error) {}
      }

      const bg = meta.getAttribute?.("content") || "";
      if (!hasVisibleColor(bg)) {
        continue;
      }

      const rootStyle = doc.documentElement ? view.getComputedStyle(doc.documentElement) : null;
      const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
      const bgRgb = parseCssRgb(bg);
      return {
        bg,
        fg: getReadableForeground(bg, [
          bodyStyle?.color || null,
          rootStyle?.color || null,
          bgRgb ? chooseForeground(bgRgb) : null,
        ]),
        source: "theme-color",
      };
    }

    return null;
  }

  function getDocumentCanvasTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    const root = doc?.documentElement;
    if (!doc || !view || !root) {
      return null;
    }

    const rootStyle = view.getComputedStyle(root);
    const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
    let canvasFg = "";
    let probe = null;
    try {
      probe = doc.createElement("div");
      probe.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;background-color:Canvas;color:CanvasText;";
      root.appendChild(probe);
      canvasFg = view.getComputedStyle(probe).color;
    } catch (error) {
    } finally {
      try {
        probe?.remove?.();
      } catch (error) {}
    }

    const bg = [
      bodyStyle ? getStyleBackground(bodyStyle) : null,
      getStyleBackground(rootStyle),
    ].find(hasVisibleColor);
    if (!bg) {
      return null;
    }

    return {
      bg,
      fg: getReadableForeground(bg, [
        bodyStyle?.color || null,
        rootStyle?.color || null,
        canvasFg || null,
      ]),
      source: "document-canvas",
    };
  }

  function getThemeFromElement(view, element, source = "element", allowPageFallback = true) {
    if (!view || !element) {
      return null;
    }

    let fg = null;
    let bg = null;
    let current = element;
    const doc = element.ownerDocument || null;

    while (current) {
      if (!allowPageFallback && (current === doc?.body || current === doc?.documentElement)) {
        break;
      }
      const style = view.getComputedStyle(current);
      if (!fg && hasVisibleColor(style.color)) {
        fg = style.color;
      }
      const background = getStyleBackground(style);
      if (!bg && hasVisibleColor(background)) {
        bg = background;
      }
      if (bg && fg) {
        break;
      }
      current = current.parentElement;
    }

    if (!hasVisibleColor(bg)) {
      return null;
    }

    return {
      bg,
      fg: getReadableForeground(bg, [fg]),
      source,
    };
  }

  function getTopVisibleTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) {
      return null;
    }

    const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
    const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
    const xMid = Math.max(1, Math.floor((width || 2) / 2));
    const xEnd = Math.max(1, (width || 2) - 2);
    const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
    const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
    const points = [
      [1, yTop],
      [xMid, yTop],
      [xEnd, yTop],
      [1, yBand],
      [xMid, yBand],
    ];
    let firstRendered = null;

    const isRenderedElement = (candidate) => {
      if (!candidate) {
        return false;
      }
      const rect = candidate.getBoundingClientRect?.();
      const style = view.getComputedStyle(candidate);
      return (
        rect?.width > 0 &&
        rect?.height > 0 &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        style.display !== "none" &&
        Number(style.opacity || 1) > 0.05
      );
    };

    for (const [x, y] of points) {
      const elements = doc.elementsFromPoint?.(x, y) || [];
      for (const element of elements) {
        if (!isRenderedElement(element)) {
          continue;
        }
        firstRendered ||= element;
        const background = getStyleBackground(view.getComputedStyle(element));
        if (hasVisibleColor(background)) {
          return getThemeFromElement(view, element, "top-visible", false);
        }
      }
    }

    return getThemeFromElement(
      view,
      firstRendered || doc.elementFromPoint?.(1, 3),
      "top-visible",
      false
    );
  }

  function getChromeToolbarFallbackTheme(win) {
    const doc = win.document;
    const probe = doc.createElement("div");
    probe.style.position = "fixed";
    probe.style.pointerEvents = "none";
    probe.style.opacity = "0";
    probe.style.backgroundColor = "var(--zen-main-browser-background-toolbar)";
    probe.style.color = "var(--toolbox-textcolor)";
    doc.documentElement.appendChild(probe);
    const probeStyle = win.getComputedStyle(probe);
    const toolbarBg = probeStyle.backgroundColor;
    const toolbarFg = probeStyle.color;
    probe.remove();

    const rootStyle = win.getComputedStyle(doc.documentElement);
    const rootBg = rootStyle.backgroundColor;
    const bg = [toolbarBg, rootBg, "Canvas"].find(hasVisibleColor) || "Canvas";
    return {
      bg,
      fg: getReadableForeground(bg, [toolbarFg]),
      source: "toolbar-fallback",
    };
  }

  async function getContentTaskPageTheme(browser) {
    if (!browser || typeof ContentTask === "undefined" || !ContentTask?.spawn) {
      return null;
    }

    try {
      return await ContentTask.spawn(browser, null, () => {
        const parseCssRgb = (input) => {
          if (!input) return null;
          const raw = String(input).trim();
          const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
          if (hex) {
            const value = hex[1];
            const expand = (part) => part.length === 1 ? `${part}${part}` : part;
            return {
              r: parseInt(expand(value.length <= 4 ? value[0] : value.slice(0, 2)), 16),
              g: parseInt(expand(value.length <= 4 ? value[1] : value.slice(2, 4)), 16),
              b: parseInt(expand(value.length <= 4 ? value[2] : value.slice(4, 6)), 16),
            };
          }
          const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
          if (!rgb) return null;
          const parts = rgb[1].replace(/\s*\/\s*[\d.]+%?$/, "").split(/[,\s]+/).filter(Boolean);
          if (parts.length < 3) return null;
          const read = (part) => {
            const value = parseFloat(part);
            return Math.max(0, Math.min(255, Math.round(String(part).trim().endsWith("%") ? value * 2.55 : value)));
          };
          return { r: read(parts[0]), g: read(parts[1]), b: read(parts[2]) };
        };
        const luminance = (color) => {
          const toLinear = (channel) => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
        };
        const alpha = (value) => {
          const match = String(value || "").trim().match(/^[a-z-]+\(([^)]+)\)$/i);
          if (!match) return null;
          const body = match[1].trim();
          const raw = body.includes("/") ? body.slice(body.lastIndexOf("/") + 1).trim() : body.split(",")[3]?.trim();
          if (!raw) return null;
          const amount = parseFloat(raw);
          return Number.isFinite(amount) ? (raw.endsWith("%") ? amount / 100 : amount) : null;
        };
        const visible = (input) => {
          const value = String(input || "").trim().toLowerCase();
          if (!value || value === "transparent") return false;
          const a = alpha(value);
          return a === null || a >= 0.08;
        };
        const extractColor = (input) =>
          (String(input || "").match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || []).find(visible) || null;
        const styleBackground = (style) => visible(style?.backgroundColor) ? style.backgroundColor : extractColor(style?.backgroundImage);
        const chooseFg = (bg) => {
          const rgb = parseCssRgb(bg);
          return rgb && luminance(rgb) > 0.6 ? "rgba(11, 13, 16, 0.92)" : "rgba(245, 247, 251, 0.96)";
        };
        const readableFg = (bg, candidates = []) =>
          candidates.find((candidate) => {
            if (!visible(candidate)) return false;
            const bgRgb = parseCssRgb(bg);
            const fgRgb = parseCssRgb(candidate);
            if (!bgRgb || !fgRgb) return false;
            const light = Math.max(luminance(bgRgb), luminance(fgRgb));
            const dark = Math.min(luminance(bgRgb), luminance(fgRgb));
            return (light + 0.05) / (dark + 0.05) >= 3;
          }) || chooseFg(bg);
        const themeFromElement = (view, element, source, allowPageFallback = true) => {
          if (!view || !element) return null;
          let fg = null;
          let bg = null;
          let current = element;
          const doc = element.ownerDocument;
          while (current) {
            if (!allowPageFallback && (current === doc.body || current === doc.documentElement)) break;
            const style = view.getComputedStyle(current);
            if (!fg && visible(style.color)) fg = style.color;
            const background = styleBackground(style);
            if (!bg && visible(background)) bg = background;
            if (bg && fg) break;
            current = current.parentElement;
          }
          return visible(bg) ? { bg, fg: readableFg(bg, [fg]), source } : null;
        };
        const themeColorTheme = (doc, view) => {
          for (const meta of doc.querySelectorAll?.('meta[name="theme-color" i]') || []) {
            const media = meta.getAttribute?.("media") || "";
            try {
              if (media && !view.matchMedia(media).matches) continue;
            } catch {}
            const bg = meta.getAttribute?.("content") || "";
            if (!visible(bg)) continue;
            const rootStyle = doc.documentElement ? view.getComputedStyle(doc.documentElement) : null;
            const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
            return {
              bg,
              fg: readableFg(bg, [bodyStyle?.color || null, rootStyle?.color || null]),
              source: "theme-color",
            };
          }
          return null;
        };
        const topVisibleTheme = (doc, view) => {
          const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
          const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
          const xMid = Math.max(1, Math.floor((width || 2) / 2));
          const xEnd = Math.max(1, (width || 2) - 2);
          const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
          const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
          const points = [[1, yTop], [xMid, yTop], [xEnd, yTop], [1, yBand], [xMid, yBand]];
          let firstRendered = null;
          const isRendered = (candidate) => {
            if (!candidate) return false;
            const rect = candidate.getBoundingClientRect?.();
            const style = view.getComputedStyle(candidate);
            return rect?.width > 0 && rect?.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && Number(style.opacity || 1) > 0.05;
          };
          for (const [x, y] of points) {
            for (const element of doc.elementsFromPoint?.(x, y) || []) {
              if (!isRendered(element)) continue;
              firstRendered ||= element;
              const background = styleBackground(view.getComputedStyle(element));
              if (visible(background)) return themeFromElement(view, element, "top-visible", false);
            }
          }
          return themeFromElement(view, firstRendered || doc.elementFromPoint?.(1, 3), "top-visible", false);
        };
        const canvasTheme = (doc, view) => {
          const root = doc.documentElement;
          const rootStyle = view.getComputedStyle(root);
          const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
          const bg = [bodyStyle ? styleBackground(bodyStyle) : null, styleBackground(rootStyle)].find(visible);
          return visible(bg)
            ? { bg, fg: readableFg(bg, [bodyStyle?.color || null, rootStyle?.color || null]), source: "document-canvas" }
            : null;
        };

        try {
          const doc = content.document;
          const view = doc?.defaultView;
          if (!doc || !view || !doc.documentElement) return null;
          const href = content.location.href;
          const theme =
            topVisibleTheme(doc, view) ||
            themeColorTheme(doc, view) ||
            themeFromElement(view, doc.body, "body") ||
            themeFromElement(view, doc.documentElement, "html") ||
            canvasTheme(doc, view);
          return theme ? { ...theme, href, bridge: "content" } : null;
        } catch {
          return null;
        }
      });
    } catch (error) {
      log("Little Zen ContentTask theme lookup failed", error);
      return null;
    }
  }

  function getLittleZenBrowserMessageManager(browser) {
    return browser?.messageManager || browser?.frameLoader?.messageManager || null;
  }

  function getLittleZenThemeFrameScript(requestId) {
    return `
      (() => {
        const requestId = ${JSON.stringify(requestId)};
        const messageName = ${JSON.stringify(LITTLE_ZEN_THEME_MESSAGE_NAME)};
        const send = (payload) => sendAsyncMessage(messageName, { requestId, ...payload });
        const alpha = value => {
          const match = String(value || "").trim().match(/^[a-z-]+\\(([^)]+)\\)$/i);
          if (!match) return null;
          const body = match[1].trim();
          const raw = body.includes("/") ? body.slice(body.lastIndexOf("/") + 1).trim() : body.split(",")[3]?.trim();
          if (!raw) return null;
          const amount = parseFloat(raw);
          return Number.isFinite(amount) ? (raw.endsWith("%") ? amount / 100 : amount) : null;
        };
        const visible = input => {
          const value = String(input || "").trim().toLowerCase();
          if (!value || value === "transparent") return false;
          const a = alpha(value);
          return a === null || a >= 0.08;
        };
        const extractColor = input =>
          (String(input || "").match(/[a-z-]+\\([^)]*\\)|#[0-9a-f]{3,8}\\b/gi) || []).find(visible) || null;
        const styleBackground = style => visible(style?.backgroundColor) ? style.backgroundColor : extractColor(style?.backgroundImage);
        const parseRgb = input => {
          const raw = String(input || "").trim();
          const rgb = raw.match(/^rgba?\\(([^)]+)\\)$/i);
          if (!rgb) return null;
          const parts = rgb[1].replace(/\\s*\\/\\s*[\\d.]+%?$/, "").split(/[,\\s]+/).filter(Boolean);
          if (parts.length < 3) return null;
          const read = part => {
            const value = parseFloat(part);
            return Math.max(0, Math.min(255, Math.round(String(part).trim().endsWith("%") ? value * 2.55 : value)));
          };
          return { r: read(parts[0]), g: read(parts[1]), b: read(parts[2]) };
        };
        const luminance = color => {
          const lin = channel => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
        };
        const chooseFg = bg => {
          const rgb = parseRgb(bg);
          return rgb && luminance(rgb) > 0.6 ? "rgba(11, 13, 16, 0.92)" : "rgba(245, 247, 251, 0.96)";
        };
        const themeFromElement = (view, element, source, allowPageFallback = true) => {
          if (!view || !element) return null;
          let bg = null;
          let fg = null;
          let current = element;
          const doc = element.ownerDocument;
          while (current) {
            if (!allowPageFallback && (current === doc.body || current === doc.documentElement)) break;
            const style = view.getComputedStyle(current);
            if (!fg && visible(style.color)) fg = style.color;
            const background = styleBackground(style);
            if (!bg && visible(background)) bg = background;
            if (bg && fg) break;
            current = current.parentElement;
          }
          return visible(bg) ? { bg, fg: fg || chooseFg(bg), source } : null;
        };
        const topVisibleTheme = (doc, view) => {
          const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
          const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
          const xMid = Math.max(1, Math.floor((width || 2) / 2));
          const xEnd = Math.max(1, (width || 2) - 2);
          const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
          const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
          const points = [[1, yTop], [xMid, yTop], [xEnd, yTop], [1, yBand], [xMid, yBand]];
          let firstRendered = null;
          for (const [x, y] of points) {
            for (const element of doc.elementsFromPoint?.(x, y) || []) {
              if (!element) continue;
              const rect = element.getBoundingClientRect?.();
              const style = view.getComputedStyle(element);
              if (!(rect?.width > 0 && rect?.height > 0) || style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none" || Number(style.opacity || 1) <= 0.05) continue;
              firstRendered ||= element;
              if (visible(styleBackground(style))) return themeFromElement(view, element, "top-visible", false);
            }
          }
          return themeFromElement(view, firstRendered || doc.elementFromPoint?.(1, 3), "top-visible", false);
        };
        const themeColorTheme = (doc, view) => {
          for (const meta of doc.querySelectorAll?.('meta[name="theme-color" i]') || []) {
            const media = meta.getAttribute?.("media") || "";
            try { if (media && !view.matchMedia(media).matches) continue; } catch {}
            const bg = meta.getAttribute?.("content") || "";
            if (visible(bg)) return { bg, fg: chooseFg(bg), source: "theme-color" };
          }
          return null;
        };
        try {
          if (content.top !== content) return;
          const doc = content.document;
          const view = doc?.defaultView;
          if (!doc || !view || !doc.documentElement) return send({ ok: false });
          const theme =
            topVisibleTheme(doc, view) ||
            themeColorTheme(doc, view) ||
            themeFromElement(view, doc.body, "body") ||
            themeFromElement(view, doc.documentElement, "html");
          send({ ok: true, theme: theme ? { ...theme, href: content.location.href, bridge: "message-manager" } : null });
        } catch (error) {
          send({ ok: false, error: error?.message || String(error) });
        }
      })();
    `;
  }

  async function getMessageManagerPageTheme(browser) {
    const messageManager = getLittleZenBrowserMessageManager(browser);
    if (!browser || !messageManager?.loadFrameScript || !messageManager?.addMessageListener) {
      return null;
    }

    const requestId = `little-zen-theme-${Date.now()}-${++littleZenThemeRequestSeq}`;
    return await new Promise((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const finish = (theme) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        try {
          messageManager.removeMessageListener(LITTLE_ZEN_THEME_MESSAGE_NAME, listener);
        } catch (error) {}
        resolve(theme || null);
      };
      const listener = {
        receiveMessage(message) {
          const data = message?.data;
          if (!data || data.requestId !== requestId) {
            return;
          }
          finish(data.theme || null);
        },
      };

      const ownerWindow = browser.ownerGlobal || window;
      timeoutId = ownerWindow.setTimeout(
        () => finish(null),
        LITTLE_ZEN_THEME_BRIDGE_TIMEOUT_MS
      );
      try {
        messageManager.addMessageListener(LITTLE_ZEN_THEME_MESSAGE_NAME, listener);
        const scriptUrl = `data:application/javascript;charset=utf-8,${encodeURIComponent(
          getLittleZenThemeFrameScript(requestId)
        )}`;
        messageManager.loadFrameScript(scriptUrl, false);
      } catch (error) {
        finish(null);
      }
    });
  }

  async function getLittleZenAsyncPageTheme(browser) {
    const lookups = [
      getContentTaskPageTheme(browser),
      getMessageManagerPageTheme(browser),
    ];

    return await new Promise((resolve) => {
      let pending = lookups.length;
      const finishEmpty = () => {
        pending--;
        if (pending === 0) {
          resolve(null);
        }
      };

      for (const lookup of lookups) {
        Promise.resolve(lookup)
          .then((theme) => {
            if (theme?.bg) {
              resolve(theme);
            } else {
              finishEmpty();
            }
          })
          .catch(() => finishEmpty());
      }
    });
  }

  function getLittleZenChromePageTheme(win) {
    const browser = win.gBrowser?.selectedBrowser;
    const href = getLittleZenThemeUrl(win)?.href || "";
    const browserHref = browser?.currentURI?.spec || "";
    let docHref = "";
    let theme = null;
    try {
      docHref = browser?.contentDocument?.location?.href || "";
      const chromeThemeAllowed = !docHref || !browserHref || docHref === browserHref;
      theme =
        (chromeThemeAllowed ? getTopVisibleTheme(browser) : null) ||
        (chromeThemeAllowed ? getThemeColorTheme(browser) : null) ||
        (chromeThemeAllowed ? getThemeFromElement(browser?.contentDocument?.defaultView, browser?.contentDocument?.body, "body") : null) ||
        (chromeThemeAllowed ? getThemeFromElement(browser?.contentDocument?.defaultView, browser?.contentDocument?.documentElement, "html") : null) ||
        (chromeThemeAllowed ? getDocumentCanvasTheme(browser) : null);
    } catch (error) {
      log("Little Zen page theme probe failed", error);
    }
    theme =
      theme ||
      (href ? null : getNeutralHeaderShade(win)) ||
      getChromeToolbarFallbackTheme(win);
    return {
      ...theme,
      href,
    };
  }

  function getLittleZenThemeUrl(win) {
    try {
      const spec =
        win.gBrowser?.selectedBrowser?.currentURI?.spec ||
        win.__littleZenRoutedURL ||
        win.__littleZenPendingURL;
      if (spec && !spec.startsWith("about:")) {
        return new URL(spec);
      }
    } catch (error) {}
    return null;
  }

  function getLittleZenThemeCacheKeys(href) {
    const keys = [];
    const raw = String(href || "");
    if (!raw) {
      return keys;
    }
    keys.push(`page:${raw}`);
    try {
      const url = new URL(raw);
      if (/^https?:$/i.test(url.protocol) && url.hostname) {
        keys.push(`host:${url.hostname.toLowerCase()}`);
      }
    } catch (error) {}
    return keys;
  }

  function rememberLittleZenTheme(theme, href) {
    if (!theme?.bg || !href || theme.source === "toolbar-fallback" || theme.source === "unknown-page") {
      return;
    }
    for (const key of getLittleZenThemeCacheKeys(href)) {
      littleZenThemeCache.set(key, theme);
    }
    while (littleZenThemeCache.size > LITTLE_ZEN_THEME_CACHE_LIMIT) {
      littleZenThemeCache.delete(littleZenThemeCache.keys().next().value);
    }
  }

  function getRememberedLittleZenTheme(href) {
    for (const key of getLittleZenThemeCacheKeys(href)) {
      const theme = littleZenThemeCache.get(key);
      if (theme?.bg) {
        return {
          ...theme,
          source: theme.source === "host-cache" ? "host-cache" : theme.source || "target-cache",
        };
      }
    }
    return null;
  }

  function applyLittleZenResolvedTheme(win, theme, reason = "unknown") {
    if (!isLittleWindow(win) || !theme) {
      return;
    }

    const root = win.document.documentElement;
    const url = getLittleZenThemeUrl(win);
    const themeColor = theme?.bg || (
      root.hasAttribute("zen-should-be-dark-mode")
        ? "rgb(16, 18, 24)"
        : "rgb(245, 247, 251)"
    );
    const themeRgb = parseCssRgb(themeColor) || (
      root.hasAttribute("zen-should-be-dark-mode")
        ? { r: 16, g: 18, b: 24 }
        : { r: 245, g: 247, b: 251 }
    );
    const header = themeColor;
    const foreground = getStableHeaderForeground(themeRgb, theme?.fg);
    const windowBackground = themeColor;
    const isLightTheme = getRelativeLuminance(themeRgb) > 0.56;
    const controlOutline = isLightTheme
      ? "rgba(0, 0, 0, 0.14)"
      : "rgba(255, 255, 255, 0.13)";
    const pageOutline = isLightTheme
      ? "rgba(0, 0, 0, 0.24)"
      : "rgba(255, 255, 255, 0.22)";
    const tintBackground = windowBackground;

    setCssVar(root, "--little-zen-page-header-background", header);
    setCssVar(root, "--little-zen-page-header-foreground", foreground);
    setCssVar(root, "--little-zen-window-theme-background", windowBackground);
    setCssVar(root, "--little-zen-theme-outline", controlOutline);
    setCssVar(root, "--little-zen-page-outline", pageOutline);
    setCssVar(root, "--blended-addressbar-frame-background", windowBackground);
    setCssVar(root, "--blended-addressbar-window-tint-background", tintBackground);
    setCssVar(
      win.document.getElementById("zen-browser-background"),
      "--blended-addressbar-window-tint-background",
      tintBackground
    );
    rememberLittleZenTheme(theme, theme.href || url?.href || "");

    log("Little Zen blended theme updated", {
      reason,
      href: url?.href ?? null,
      source: theme?.source ?? null,
      header,
      foreground,
      windowBackground,
      controlOutline,
      pageOutline,
      tintBackground,
    });
  }

  async function updateLittleZenBlendedTheme(win, reason = "unknown") {
    if (!isLittleWindow(win)) {
      return;
    }

    const browser = win.gBrowser?.selectedBrowser;
    const expectedHref = getLittleZenThemeUrl(win)?.href || "";
    const chromeTheme = getLittleZenChromePageTheme(win);
    const rememberedTheme = getRememberedLittleZenTheme(expectedHref);
    if (rememberedTheme?.bg && chromeTheme?.source === "toolbar-fallback") {
      applyLittleZenResolvedTheme(win, rememberedTheme, `${reason}:retained`);
    } else {
      applyLittleZenResolvedTheme(win, chromeTheme, reason);
    }

    const contentTheme = await getLittleZenAsyncPageTheme(browser);
    if (!contentTheme?.bg || !isLittleWindow(win)) {
      return;
    }
    const currentHref = getLittleZenThemeUrl(win)?.href || "";
    if (expectedHref && currentHref && expectedHref !== currentHref) {
      return;
    }
    applyLittleZenResolvedTheme(win, contentTheme, `${reason}:content`);
  }

  function getLittleWindowUrl(win) {
    try {
      const browser = win.gBrowser?.selectedBrowser;
      const spec = browser?.currentURI?.spec;
      if (spec && spec !== "about:blank" && spec !== "about:newtab") {
        return spec;
      }
    } catch (e) {}
    return null;
  }

  function getLittleWindowRouteUrl(win) {
    return (
      win?.__littleZenRoutedURL ||
      win?.__littleZenPendingURL ||
      getLittleWindowUrl(win)
    );
  }

  function getInitialTargetWorkspaceId(win, mainWin) {
    // A manually moved live tab returns to its original Space even when its
    // URL would route new external links somewhere else.
    const returnWorkspace = win?.__littleZenReturnWorkspaceId &&
      getWorkspaceById(mainWin, win.__littleZenReturnWorkspaceId);
    if (returnWorkspace) return returnWorkspace.uuid;
    const activeWorkspaceId = getActiveWorkspaceId(mainWin);
    const url = getLittleWindowRouteUrl(win);
    const routeDebugBase = {
      routedUrl: win?.__littleZenRoutedURL ?? null,
      pendingUrl: win?.__littleZenPendingURL ?? null,
      currentUrl: getLittleWindowUrl(win),
      selectedUrl: url,
      activeWorkspaceId,
      workspaces: getWorkspaces(mainWin).map((workspace) => ({
        uuid: workspace?.uuid ?? null,
        id: workspace?.id ?? null,
        name: workspace?.name ?? null,
      })),
    };

    if (!url) {
      routeLog("Little Zen routing target: no URL, using active workspace", routeDebugBase);
      return activeWorkspaceId;
    }

    try {
      const routingManager = mainWin.gZenSpaceRoutingManager;
      const route = mainWin.gZenSpaceRoutingManager?.routeUri?.(url, {
        fromExternal: true,
      });
      const defaultExternalRoute =
        routingManager?.getDefaultExternalRoute?.() ?? null;
      routeLog("Little Zen routing target: routeUri result", {
        ...routeDebugBase,
        route,
        defaultExternalRoute,
      });
      if (route && route !== "most-recent-space") {
        const workspace = getWorkspaceByRouteTarget(mainWin, route);
        if (workspace) {
          routeLog("Little Zen routing target: resolved routed workspace", {
            route,
            workspaceId: workspace.uuid,
            workspaceName: workspace.name,
          });
          return workspace.uuid;
        }
        routeLog("Little Zen routing target: route did not match a workspace", {
          route,
          ...routeDebugBase,
        });
      }
    } catch (error) {
      log("Could not resolve Little Zen route target workspace", {
        error,
        ...routeDebugBase,
      });
    }

    routeLog("Little Zen routing target: using active workspace fallback", routeDebugBase);
    return activeWorkspaceId;
  }

  function resolveLittleZenTargetWorkspace(win, mainWin, reason = "unknown") {
    const workspaceId = getInitialTargetWorkspaceId(win, mainWin);
    const workspace = getWorkspaceById(mainWin, workspaceId);
    routeLog("Little Zen routing target: final workspace decision", {
      reason,
      workspaceId,
      workspaceName: workspace?.name ?? null,
      containerTabId: getWorkspaceContainerId(workspace),
      routeUrl: getLittleWindowRouteUrl(win),
    });
    return workspace;
  }

  function resolveLittleZenRoutingDecision(
    win,
    mainWin,
    url,
    triggeringPrincipal,
    reason = "unknown"
  ) {
    let beforeRouteResult = null;
    let userContextId;
    let hasZenDefaultUserContextId = false;
    let forcedWorkspaceId;

    try {
      beforeRouteResult = mainWin.gZenSpaceRoutingManager?.onBeforeAddTab?.(
        url,
        {
          fromExternal: true,
          skipRoute: false,
          pinned: false,
          tabGroup: null,
        },
        mainWin
      );
    } catch (error) {
      log("Little Zen routing target: onBeforeAddTab failed", {
        error,
        url,
        reason,
      });
    }

    if (beforeRouteResult?.isRouteFound) {
      userContextId = beforeRouteResult.userContextId;
      hasZenDefaultUserContextId = true;
      forcedWorkspaceId = beforeRouteResult.targetRoute;
    } else {
      try {
        [userContextId, hasZenDefaultUserContextId, forcedWorkspaceId] =
          mainWin.gZenWorkspaces?.getContextIdIfNeeded?.(
            undefined,
            true,
            triggeringPrincipal
          ) ?? [undefined, false, undefined];
      } catch (error) {
        log("Little Zen routing target: getContextIdIfNeeded failed", {
          error,
          url,
          reason,
        });
      }
    }

    const routeWorkspace =
      getWorkspaceByRouteTarget(mainWin, beforeRouteResult?.targetRoute) ??
      getWorkspaceById(mainWin, forcedWorkspaceId) ??
      resolveLittleZenTargetWorkspace(win, mainWin, reason);
    const targetContainerId =
      typeof userContextId === "undefined" || userContextId === null
        ? getWorkspaceContainerId(routeWorkspace)
        : Number.parseInt(userContextId, 10) || 0;

    routeLog("Little Zen routing target: Zen routing decision", {
      reason,
      url,
      beforeRouteResult,
      forcedWorkspaceId,
      targetWorkspaceId: routeWorkspace?.uuid ?? null,
      targetWorkspaceName: routeWorkspace?.name ?? null,
      userContextId,
      targetContainerId,
      hasZenDefaultUserContextId,
    });

    return {
      beforeRouteResult,
      targetWorkspace: routeWorkspace,
      targetContainerId,
      hasZenDefaultUserContextId,
    };
  }

  function setCssVar(element, name, value) {
    if (!element?.style) {
      return;
    }
    if (value) {
      element.style.setProperty(name, value);
    } else {
      element.style.removeProperty(name);
    }
  }

  async function placeTabInWorkspace(mainWin, tab, workspaceId) {
    const workspaces = mainWin?.gZenWorkspaces;
    if (!workspaces || !tab || !workspaceId) {
      return false;
    }

    try {
      if (typeof workspaces.moveTabToWorkspace === "function") {
        workspaces.moveTabToWorkspace(tab, workspaceId);
      } else {
        tab.setAttribute("zen-workspace-id", workspaceId);
      }

      if (workspaces.lastSelectedWorkspaceTabs) {
        workspaces.lastSelectedWorkspaceTabs[workspaceId] = tab;
      }

      if (typeof workspaces.changeWorkspaceWithID === "function") {
        await workspaces.changeWorkspaceWithID(workspaceId);
      } else {
        const workspace = getWorkspaceById(mainWin, workspaceId);
        if (workspace) {
          await workspaces.changeWorkspace?.(workspace);
        }
      }

      mainWin.gBrowser.selectedTab = tab;
      mainWin.gBrowser.selectedBrowser?.focus?.();
      return true;
    } catch (error) {
      log("placeTabInWorkspace failed", error);
      return false;
    }
  }

  async function transferTabToWorkspace(win, workspaceId) {
    if (win.__littleZenTransferInProgress) {
      return;
    }
    const mainWin = getMainBrowserWindow(win);
    const sourceTab = win.gBrowser?.selectedTab;
    if (!mainWin || !sourceTab?.linkedBrowser || sourceTab.hasAttribute("zen-empty-tab")) {
      log("transferTabToWorkspace: no live tab or main window available");
      return;
    }

    win.__littleZenTransferInProgress = true;
    try {
      await mainWin.gZenStartup?.promiseInitialized;
      const workspace = getWorkspaceById(mainWin, workspaceId);
      if (!workspace || !mainWin.gZenWorkspaces.workspaceElement(workspaceId)) {
        throw new Error("Destination workspace is unavailable");
      }
      if (typeof mainWin.gBrowser.adoptTab !== "function") {
        throw new Error("Live tab adoption is unavailable in this Zen version");
      }
      await mainWin.gZenWorkspaces.changeWorkspaceWithID(workspaceId);
      if (win.closed || !sourceTab.isConnected || sourceTab.closing) {
        throw new Error("Source tab closed before transfer");
      }

      // Adopt the existing browser/docshell instead of reloading its URL.
      // The page keeps its live state and its original cookie container.
      const adoptedTab = mainWin.gBrowser.adoptTab(sourceTab, { tabIndex: Infinity });
      if (!adoptedTab?.linkedBrowser) {
        throw new Error("Zen did not adopt the tab; leaving Little Zen open");
      }
      if (!await placeTabInWorkspace(mainWin, adoptedTab, workspaceId)) {
        throw new Error("Tab adopted, but destination workspace placement failed");
      }
      mainWin.focus();
      log("Adopted live Little Zen tab into workspace", {
        workspaceId, workspaceName: workspace.name,
        containerTabId: getTabContainerId(adoptedTab),
      });
      if (!win.closed) {
        win.close();
      }
    } catch (error) {
      // Never discard the source page as a fallback or recreate it from a URL.
      log("transferTabToWorkspace failed; retaining the available live page", error);
    } finally {
      delete win.__littleZenTransferInProgress;
    }
  }


  function buildSpacePicker(win) {
    const doc = win.document;
    if (doc.getElementById(PICKER_ID)) {
      return;
    }

    const mainWin = getMainBrowserWindow(win);
    if (!mainWin) {
      return;
    }

    // Split workspace control, mirroring Zen's toolbarbutton/menuitem shape.
    const picker = doc.createXULElement("toolbaritem");
    picker.id = PICKER_ID;
    picker.setAttribute("align", "center");
    picker.classList.add("chromeclass-toolbar-additional");

    const openButton = doc.createXULElement("toolbarbutton");
    openButton.id = PICKER_ID + "-open";
    openButton.classList.add(
      "toolbarbutton-1",
      "chromeclass-toolbar-additional",
      "zen-little-window-space-button"
    );
    openButton.setAttribute("crop", "end");
    openButton.setAttribute("flex", "1");
    openButton.setAttribute("orient", "horizontal");
    openButton.setAttribute("tooltip", "dynamic-shortcut-tooltip");

    const openButtonLabel = doc.createXULElement("label");
    openButtonLabel.id = PICKER_ID + "-label";
    openButtonLabel.setAttribute("crop", "end");
    openButtonLabel.setAttribute("flex", "1");
    openButton.appendChild(openButtonLabel);

    const shortcutHint = doc.createXULElement("label");
    shortcutHint.id = PICKER_ID + "-shortcut";
    shortcutHint.setAttribute("value", getOpenShortcutDisplay());
    shortcutHint.setAttribute("tooltiptext", "Open in main window");
    openButton.appendChild(shortcutHint);

    const arrow = doc.createXULElement("toolbarbutton");
    arrow.id = PICKER_ID + "-arrow";
    arrow.classList.add(
      "toolbarbutton-1",
      "chromeclass-toolbar-additional",
      "zen-little-window-space-arrow"
    );
    arrow.setAttribute("type", "menu");
    arrow.setAttribute("label", "▾");
    arrow.setAttribute("orient", "horizontal");

    const arrowLabel = doc.createXULElement("label");
    arrowLabel.id = PICKER_ID + "-arrow-label";
    arrowLabel.setAttribute("value", "▾");
    arrow.appendChild(arrowLabel);

    // Popup menu
    const popup = doc.createXULElement("menupopup");
    popup.id = PICKER_MENU_ID;
    popup.setAttribute("ignorekeys", "true");

    picker.appendChild(openButton);
    picker.appendChild(arrow);
    arrow.appendChild(popup);

    // State: which workspace is targeted
    let targetWorkspaceId = getInitialTargetWorkspaceId(win, mainWin);

    const applyWorkspaceTheme = (wsId) => {
      try {
        const root = doc.documentElement;
        setCssVar(root, "--little-zen-window-background", "");
        setCssVar(root, "--little-zen-window-toolbar-background", "");
        picker.setAttribute("zen-workspace-id", wsId ?? "");
      } catch (e) {}
    };

    const updateLabel = () => {
      const ws = getWorkspaceById(mainWin, targetWorkspaceId);
      const name = ws?.name ?? "Space";
      const icon = ws?.icon && !ws.icon.endsWith(".svg") ? ws.icon + "  " : "";
      const label = `Open in ${icon}${name}`;
      openButton.setAttribute("label", label);
      openButton.setAttribute("shortcut", getOpenShortcutDisplay());
      openButtonLabel.setAttribute("value", label);
      openButton.setAttribute("tooltiptext", `Open in ${name}`);
      arrow.setAttribute("tooltiptext", name);
      applyWorkspaceTheme(targetWorkspaceId);
    };

    const refreshRouteTarget = () => {
      const routedWorkspaceId = getInitialTargetWorkspaceId(win, mainWin);
      if (routedWorkspaceId && routedWorkspaceId !== targetWorkspaceId) {
        targetWorkspaceId = routedWorkspaceId;
        updateLabel();
      }
    };

    const openMenu = () => {
      const workspaces = getWorkspaces(mainWin);
      while (popup.firstChild) popup.removeChild(popup.firstChild);
      popup.classList.add("zen-little-window-space-menu");

      const searchRow = doc.createXULElement("hbox");
      searchRow.className = "zen-little-window-space-menu-search-row";
      searchRow.setAttribute("align", "center");

      const searchIcon = doc.createXULElement("image");
      searchIcon.className = "zen-little-window-space-menu-search-icon";
      searchRow.appendChild(searchIcon);

      const searchInput = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input"
      );
      searchInput.id = PICKER_MENU_ID + "-search";
      searchInput.className = "zen-little-window-space-menu-search";
      searchInput.setAttribute("type", "search");
      searchInput.setAttribute("placeholder", "Search spaces");
      searchInput.setAttribute("autocomplete", "off");
      searchInput.setAttribute("aria-label", "Search spaces");
      searchInput.setAttribute("dir", "ltr");
      searchRow.appendChild(searchInput);
      popup.appendChild(searchRow);

      const noResults = doc.createXULElement("label");
      noResults.className = "zen-little-window-space-menu-no-results";
      noResults.setAttribute("value", "No spaces found");
      noResults.hidden = true;
      popup.appendChild(noResults);

      const selectWorkspace = (ws) => {
        targetWorkspaceId = ws.uuid;
        updateLabel();
        try {
          popup.hidePopup();
        } catch (error) {}
      };

      const rows = [];
      workspaces.forEach(ws => {
        const item = doc.createXULElement("menuitem");
        item.className = "zen-workspace-context-menu-item zen-little-window-space-menu-item";
        item.__littleZenWorkspace = ws;
        item.setAttribute("zen-workspace-id", ws.uuid);
        const icon = getWorkspaceDisplayIcon(ws);
        const iconIsSvg = !!icon && icon.endsWith(".svg");
        if (iconIsSvg) {
          item.setAttribute("image", icon);
          item.classList.add("menuitem-iconic", "zen-workspace-context-icon");
          item.setAttribute("label", ws.name);
        } else {
          item.setAttribute("label", `${icon}  ${ws.name}`);
        }
        item.setAttribute("data-label", `${ws.name ?? ""} ${icon ?? ""}`.toLowerCase());
        if (ws.uuid === targetWorkspaceId) {
          item.setAttribute("selected", "true");
        }
        item.addEventListener("command", () => {
          selectWorkspace(ws);
        });
        item.addEventListener("DOMMenuItemActive", () => setSelectedRow(item));
        item.addEventListener("DOMMenuItemInactive", () => item.removeAttribute("selected"));
        rows.push(item);
        popup.appendChild(item);
      });

      const visibleRows = () => rows.filter(item => !item.hidden);
      const setSelectedRow = (row) => {
        rows.forEach(item => item.removeAttribute("selected"));
        row?.setAttribute("selected", "true");
        row?.scrollIntoView?.({ block: "nearest" });
      };
      const filterRows = () => {
        const query = searchInput.value.toLowerCase().trim();
        let shown = 0;
        for (const item of rows) {
          const matches = !query || item.getAttribute("data-label").includes(query);
          item.hidden = !matches;
          if (matches) {
            shown++;
          }
        }
        noResults.hidden = shown > 0;
        if (!visibleRows().some(item => item.hasAttribute("selected"))) {
          setSelectedRow(visibleRows()[0]);
        }
      };
      const moveSelection = (direction) => {
        const visible = visibleRows();
        if (!visible.length) {
          return;
        }
        const currentIndex = Math.max(
          0,
          visible.findIndex(item => item.hasAttribute("selected"))
        );
        setSelectedRow(visible[(currentIndex + direction + visible.length) % visible.length]);
      };
      const acceptSelection = () => {
        const selected = visibleRows().find(item => item.hasAttribute("selected"));
        if (selected?.__littleZenWorkspace) {
          selectWorkspace(selected.__littleZenWorkspace);
        }
      };
      const stopSearchEvent = (event) => {
        if (event.target === searchInput || searchRow.contains(event.target)) {
          if (event.type === "keydown") {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              popup.hidePopup();
              return;
            }
            if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(1);
              return;
            }
            if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(-1);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              acceptSelection();
              return;
            }
          }
          event.stopPropagation();
        }
      };

      for (const eventName of [
        "keydown",
        "keypress",
        "keyup",
        "mousedown",
        "mouseup",
        "click",
      ]) {
        popup.addEventListener(eventName, stopSearchEvent, true);
      }
      searchInput.addEventListener("input", filterRows);
      popup.addEventListener(
        "popupshown",
        () => {
          searchInput.focus();
          searchInput.select();
        },
        { once: true }
      );
      popup.openPopup(picker, "after_start", 0, 0, false, false);
    };

    const openSelectedWorkspace = () => {
      transferTabToWorkspace(win, targetWorkspaceId);
    };

    openButton.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      openSelectedWorkspace();
    });

    openButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    arrow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu();
    });

    arrow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Ctrl/Cmd+O opens in the current target; Alt opens the Space picker.
    win.addEventListener("keydown", (e) => {
      if (
        !e.defaultPrevented &&
        !e.repeat &&
        (AppConstants.platform === "macosx" ? e.metaKey : e.ctrlKey) &&
        e.key?.toLowerCase() === "o"
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          openMenu();
        } else {
          openSelectedWorkspace();
        }
      }
    }, true);

    // Keep label in sync when main window changes workspace
    try {
      mainWin.addEventListener("ZenWorkspaceChanged", () => {
        const routedOrActiveId = getInitialTargetWorkspaceId(win, mainWin);
        if (routedOrActiveId) {
          log("Little Zen picker target refreshed after workspace change", {
            routedOrActiveId,
            activeWorkspaceId: getActiveWorkspaceId(mainWin),
            routeUrl: getLittleWindowRouteUrl(win),
          });
          targetWorkspaceId = routedOrActiveId;
          updateLabel();
        }
      });
    } catch (e) {}

    updateLabel();
    win.__littleZenRefreshSpacePickerTarget = refreshRouteTarget;
    win.setTimeout(refreshRouteTarget, 150);
    win.setTimeout(refreshRouteTarget, 750);

    const target =
      doc.getElementById("nav-bar-customization-target") ||
      doc.getElementById("nav-bar") ||
      doc.getElementById("urlbar-container");
    if (target) {
      target.appendChild(picker);
      log("Injected space picker into nav-bar target");
    }

    // Popup stays inside picker — moving it to popupSet breaks single-click command events
  }

  function ensureSpacePicker(win) {
    if (!isLittleWindow(win) || win.document.getElementById(PICKER_ID)) {
      return;
    }
    const mainWin = getMainBrowserWindow(win);
    if (!mainWin?.gZenWorkspaces) {
      // Retry until workspaces are ready
      win.setTimeout(() => ensureSpacePicker(win), 500);
      return;
    }
    buildSpacePicker(win);
  }

  // ── End Workspace Picker ─────────────────────────────────────────────────────

  function attachDoubleEscapeClose(win) {
    if (win[PATCH_FLAGS.doubleEscapeClose]) {
      return;
    }

    let lastEscapeAt = 0;
    const onKeyDown = event => {
      if (!isLittleWindow(win) || event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      const now = win.performance?.now?.() ?? Date.now();
      if (lastEscapeAt > 0 && now - lastEscapeAt <= 520) {
        event.preventDefault();
        event.stopPropagation();
        logLittleWindowState(win, "Closing Little Zen window after double Escape");
        win.close();
        return;
      }

      lastEscapeAt = now;
      win.setTimeout(() => {
        if ((win.performance?.now?.() ?? Date.now()) - lastEscapeAt >= 520) {
          lastEscapeAt = 0;
        }
      }, 560);
    };

    win.addEventListener("keydown", onKeyDown, true);
    win.addEventListener(
      "unload",
      () => {
        try {
          win.removeEventListener("keydown", onKeyDown, true);
        } catch (error) {}
      },
      { once: true }
    );
    win[PATCH_FLAGS.doubleEscapeClose] = true;
    log("Attached Little Zen double Escape close listener");
  }

  function attachAutoClose(win) {
    if (win[PATCH_FLAGS.autoClose]) {
      return;
    }

    const urlbar = win.gURLBar;

    if (win.__littleZenStartExpanded) {
      markLittleWindowEarly(win, { expanded: true });
      applyExpandedLittleWindow(win, "expanded-startup");
      win[PATCH_FLAGS.autoClose] = true;
      logLittleWindowState(win, "Opened expanded Little Zen window");
      return;
    }

    const onOpened = () => {
      releaseLittleWindowPresentation(win, "floating-urlbar-opened");
      centerWindow(win);

      try {
        focusLittleWindow(win);
        urlbar?.focus();
        urlbar?.select();
        urlbar?.inputField?.focus();
      } catch (error) {
        log("Could not focus the Little Zen urlbar.", error);
      }

      logLittleWindowState(win, "Opened Little Zen floating urlbar");
    };

    const onUnload = () => {
      cleanupLittleWindowLifecycle(win, "unload");
    };

    const cleanup = reason => {
      if (win.__littleZenLifecycleCleanup !== cleanup) {
        return;
      }

      delete win.__littleZenLifecycleCleanup;
      clearLittleWindowLoadingFallback(win);
      try {
        win.removeEventListener("ZenFloatingURLBarOpened", onOpened);
        win.removeEventListener("ZenURLBarClosed", onClosed);
        win.removeEventListener("unload", onUnload);
      } catch (error) {}
      releaseLittleWindowPresentation(win, `cleanup:${reason}`);
      logLittleWindowState(win, "Cleaned up Little Zen lifecycle", { reason });
    };

    const onClosed = event => {
      cleanup("urlbar-closed");

      if (win.closed) {
        return;
      }

      if (!event.detail?.onElementPicked && !win.__littleZenPendingURL) {
        logLittleWindowState(win, "Closing empty Little Zen window after urlbar close");
        win.close();
        return;
      }

      expandLittleWindow(
        win,
        event.detail?.onElementPicked ? "urlbar-picked" : "urlbar-closed"
      );
    };

    markLittleWindowEarly(win, {
      url: win.__littleZenPendingURL,
      meta: win.__littleZenPendingURLMeta,
    });
    win.document.documentElement.toggleAttribute("zen-no-padding", isEmptyLittleWindow(win));
    win.__littleZenLifecycleCleanup = cleanup;

    setWindowResizable(win, false);
    try {
      win.resizeTo(URLBAR_WIDTH, URLBAR_HEIGHT);
      focusLittleWindow(win);
      closeLittleWindowUrlbar(win, "attach-auto-close-disabled");
    } catch (error) {
      log("Could not size the little window.", error);
    }

    win.addEventListener("ZenFloatingURLBarOpened", onOpened, { once: true });
    win.addEventListener("ZenURLBarClosed", onClosed, { once: true });
    win.addEventListener("unload", onUnload, { once: true });
    win.gZenWorkspaces?.promiseInitialized?.finally?.(() => {
      releaseLittleWindowPresentation(win, "workspaces-ready");
    });
    win[PATCH_FLAGS.autoClose] = true;
    log("Attached Little Zen lifecycle listeners");
  }

  function restoreMacWindowControls(win) {
    if (AppConstants.platform !== "macosx") {
      return;
    }
    const target = win.document.getElementById("nav-bar-customization-target");
    const controls = win.document.getElementById("little-zen-native-controls") ||
      win.gZenVerticalTabsManager?.actualWindowButtons ||
      win.document.querySelector(".titlebar-buttonbox-container:has(.titlebar-buttonbox)");
    if (!target || !controls) {
      return;
    }
    controls.id = "little-zen-native-controls";
    const nativeBox = controls.querySelector(".titlebar-buttonbox");
    if (nativeBox) {
      // Native button geometry must be updated in the window itself; the
      // userChrome stylesheet can remain cached while Zen is running.
      nativeBox.style.setProperty("position", "relative", "important");
      nativeBox.style.setProperty("top", "8px", "important");
    }
    if (controls.parentNode !== target) {
      target.prepend(controls);
    }
    if (!win.__littleZenNativeControlsObserver) {
      // Zen's sidebar layout updates also relocate this native control box.
      // Keep it in the visible toolbar after those updates finish.
      const observer = new win.MutationObserver(() => {
        if (!win.closed && controls.parentNode !== target) {
          target.prepend(controls);
        }
      });
      observer.observe(target, { childList: true });
      win.__littleZenNativeControlsObserver = observer;
      win.addEventListener("unload", () => observer.disconnect(), { once: true });
    }
  }

  function applyLittleWindowMode(win) {
    if (!isBrowserWindow(win)) {
      return;
    }

    win.document.documentElement.setAttribute(LITTLE_WINDOW_ATTR, "true");
    patchCompactModeManager(win);
    patchVerticalTabsManager(win);
    patchZenUIManager(win);
    patchUrlbar(win);
    attachEmptyTabStateTracking(win);
    attachTransparentBrowserPrefSync(win);
    attachLittleWindowCloseButtonGuard(win);
    attachLittleWindowAppReturn(win);
    restoreMacWindowControls(win);
    if (!win.__littleZenCloseCommandPatched && win.BrowserCommands) {
      const originalCanClose = win.CanCloseWindow;
      win.CanCloseWindow = function () {
        if (!isLittleWindow(win)) {
          return originalCanClose.call(win);
        }
        if (Services.startup.shuttingDown || win.skipNextCanClose) {
          return true;
        }
        // Zen's empty/lazy placeholder tabs can have no linked browser. The
        // native helper dereferences those null entries before checking unload.
        for (const browser of win.gBrowser.browsers) {
          if (!browser?.isConnected) {
            continue;
          }
          if (!browser.permitUnload().permitUnload) {
            return false;
          }
        }
        return true;
      };
      const originalClose = win.BrowserCommands.closeTabOrWindow;
      win.BrowserCommands.closeTabOrWindow = function (event) {
        if (isLittleWindow(win)) {
          // Use the native window-close path, including beforeunload checks,
          // without removing the tab and briefly selecting Zen's start page.
          return this.tryToCloseWindow(event);
        }
        return originalClose.call(this, event);
      };
      win.__littleZenCloseCommandPatched = true;
    }
    attachDoubleEscapeClose(win);
    syncLittleWindowTransparentBrowsers(win);
    ensureLittleWindowLoadingPulse(win);
    if (win.__littleZenStartLoadingVeil || win.__littleZenPendingURL) {
      setLittleWindowLoading(win, true, "apply-mode-startup");
    }
    syncEmptyTabState(win, "apply-mode");
    updateLittleZenBlendedTheme(win, "apply-mode");
    refreshLittleWindowLayout(win);
    attachAutoClose(win);
    if (win.__littleZenPendingURL) {
      schedulePendingNavigationFlush(win, "apply-mode");
    } else if (!win.__littleZenSuppressUrlbarFocus) {
      closeLittleWindowUrlbar(win, "apply-mode-urlbar-disabled");
    }
    ensureSpacePicker(win);
    logLittleWindowState(win, "Applied Little Zen mode");
  }

  function whenStartupReady(win, callback) {
    // Firefox's delayed startup finishes before Zen restores its Spaces and
    // replaces the initial placeholder tab. Loading earlier loses the URL.
    const finish = () => {
      if (win.closed) {
        return;
      }
      win.__littleZenStartupReady = true;
      callback();
    };
    const waitForZen = () => {
      const initialized = win.gZenStartup?.promiseInitialized;
      if (initialized) {
        initialized.then(finish).catch(error => {
          log("Could not finish Little Zen startup", error);
        });
      } else {
        finish();
      }
    };

    if (win.gBrowserInit?.delayedStartupFinished) {
      waitForZen();
      return;
    }

    const observer = new win.MutationObserver(() => {
      if (!win.gBrowserInit?.delayedStartupFinished) {
        return;
      }
      observer.disconnect();
      waitForZen();
    });

    observer.observe(win.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    win.addEventListener(
      "unload",
      () => {
        observer.disconnect();
      },
      { once: true }
    );
  }

  function ensureCommand(win) {
    if (win.document.getElementById(COMMAND_ID)) {
      return;
    }

    const commandSet =
      win.document.getElementById("zenCommandSet") ||
      win.document.getElementById("mainCommandSet");
    if (!commandSet) {
      return;
    }

    const command = win.document.createXULElement("command");
    command.id = COMMAND_ID;
    command.addEventListener("command", () => {
      LittleZen.openLittleWindow(win, { expanded: true, source: "command" });
    });
    commandSet.appendChild(command);
    log("Injected cmd_zenNewLittleWindow command");
  }

  function ensureFallbackShortcut(win) {
    if (win[PATCH_FLAGS.keyListener]) {
      return;
    }

    const isAccelPressed = event =>
      AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;

    const onKeyDown = event => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.shiftKey ||
        event.getModifierState("AltGraph") ||
        !event.altKey ||
        !isAccelPressed(event) ||
        event.key?.toLowerCase() !== "n"
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      LittleZen.openLittleWindow(win, { expanded: true, source: "shortcut" });
    };

    win.addEventListener("keydown", onKeyDown, true);
    win[PATCH_FLAGS.keyListener] = true;
    log("Attached fallback Little Zen shortcut listener");
  }

  function patchContentLinkShortcut() {
    if (ClickHandlerParent[PATCH_FLAGS.contentLinkListener]) {
      return;
    }

    const originalContentAreaClick = ClickHandlerParent.prototype.contentAreaClick;
    ClickHandlerParent.prototype.contentAreaClick = function (event) {
      const usesAccel = AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      if (
        event.button !== 0 ||
        event.shiftKey ||
        !event.altKey ||
        !usesAccel
      ) {
        return originalContentAreaClick.call(this, event);
      }

      const browser = this.manager.browsingContext.top.embedderElement;
      const opener = browser?.documentGlobal;
      if (!event.href || !isBrowserWindow(opener)) {
        return originalContentAreaClick.call(this, event);
      }

      LittleZen.openLittleWindow(opener, {
        url: event.href,
        source: "ctrl-alt-click",
        triggeringPrincipal: event.triggeringPrincipal,
      });
      return undefined;
    };

    ClickHandlerParent[PATCH_FLAGS.contentLinkListener] = true;
    log("Patched remote content Ctrl+Alt+click handling");
  }

  function canMoveTabToLittleZen(win, tab) {
    return !isLittleWindow(win) && !!tab?.linkedBrowser && tab.isConnected &&
      !tab.closing && !tab.hasAttribute("zen-empty-tab") &&
      tab !== win.gZenWorkspaces?._emptyTab && !tab.splitview &&
      !tab.__littleZenMoveInProgress;
  }

  async function moveTabToLittleZen(win, tab) {
    if (!canMoveTabToLittleZen(win, tab)) return null;
    const workspaceId = tab.getAttribute("zen-workspace-id") || win.gZenWorkspaces?.activeWorkspace;
    const workspace = getWorkspaceById(win, workspaceId);
    if (!workspace) return null;
    tab.__littleZenMoveInProgress = true;
    let littleWindow = null;
    let adoptedTab = null;
    try {
      // Always create a new destination; do not reuse another empty Little Zen.
      // No URL is queued: the existing browser is adopted after Zen is ready.
      littleWindow = win.OpenBrowserWindow({
        zenLittleWindow: true, all: false, features: OPEN_FEATURES,
        private: PrivateBrowsingUtils.isWindowPrivate(win), expanded: true,
      });
      if (!littleWindow) throw new Error("Could not create Little Zen window");
      littleWindow.__littleZenSuppressUrlbarFocus = true;
      littleWindow.__littleZenReturnWorkspaceId = workspace.uuid;
      await new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer;
        const finish = error => {
          if (settled) return;
          settled = true;
          win.clearTimeout(timer);
          win.clearTimeout(pollTimer);
          Services.obs.removeObserver(onClosed, "domwindowclosed");
          if (error) reject(error); else resolve();
        };
        const onClosed = { observe(subject) {
          if (subject === littleWindow || subject === win) {
            finish(new Error("Source or destination closed during startup"));
          }
        }};
        const timer = win.setTimeout(() => finish(new Error("Little Zen startup timed out")), 20000);
        Services.obs.addObserver(onClosed, "domwindowclosed");
        const poll = () => {
          if (littleWindow.closed || win.closed) {
            finish(new Error("Source or destination closed during startup"));
          } else if (littleWindow.gBrowserInit?.delayedStartupFinished &&
                     littleWindow.gZenStartup?.promiseInitialized) {
            littleWindow.gZenStartup.promiseInitialized.then(() => finish(), finish);
          } else {
            pollTimer = win.setTimeout(poll, 50);
          }
        };
        poll();
      });
      if (littleWindow.closed || win.closed || !tab.isConnected || tab.closing) {
        throw new Error("Source or destination closed before transfer");
      }
      littleWindow.__littleZenReturnWorkspaceId = workspace.uuid;
      littleWindow.__littleZenSourceWindow = new WeakRef(win);
      associateLittleWindowWithWorkspace(littleWindow, workspace);
      const placeholders = [...littleWindow.gBrowser.tabs].filter(
        candidate => candidate !== littleWindow.gZenWorkspaces?._emptyTab
      );
      adoptedTab = littleWindow.gBrowser.adoptTab(tab, { tabIndex: Infinity });
      if (!adoptedTab?.linkedBrowser) {
        throw new Error("Zen did not adopt the live tab");
      }
      adoptedTab.setAttribute("zen-workspace-id", workspace.uuid);
      littleWindow.gBrowser.selectedTab = adoptedTab;
      for (const placeholder of placeholders) {
        if (placeholder !== adoptedTab && placeholder.isConnected && !placeholder.closing) {
          littleWindow.gBrowser.removeTab(placeholder, { animate: false });
        }
      }
      syncLittleWindowTransparentBrowsers(littleWindow);
      applyExpandedLittleWindow(littleWindow, "tab-context-menu");
      setLittleWindowLoading(littleWindow, false, "live-tab-moved");
      littleWindow.__littleZenRefreshSpacePickerTarget?.();
      updateLittleZenBlendedTheme(littleWindow, "live-tab-moved");
      focusLittleWindow(littleWindow);
      littleWindow.gBrowser.selectedBrowser.focus();
      log("Moved live tab to Little Zen", { workspaceId: workspace.uuid });
      return littleWindow;
    } catch (error) {
      log("Move to Little Zen failed; retaining the live page", error);
      // Close only an unused destination. Once adoption succeeds, the live
      // document belongs there and must survive any subsequent layout error.
      if (!adoptedTab?.linkedBrowser && littleWindow && !littleWindow.closed) {
        littleWindow.close();
      }
      return adoptedTab?.linkedBrowser ? littleWindow : null;
    } finally {
      delete tab.__littleZenMoveInProgress;
    }
  }

  function attachTabContextMenu(win) {
    if (isLittleWindow(win)) return;
    const popup = win.document.getElementById("tabContextMenu");
    if (!popup || win.document.getElementById("context_moveTabToLittleZen")) return;
    const item = win.document.createXULElement("menuitem");
    item.id = "context_moveTabToLittleZen";
    item.setAttribute("label", "Move to Little Zen");
    // Native popuphidden clears TabContextMenu.contextTab; keep this menu's
    // target available if the command arrives after dismissal.
    let contextTab = null;
    const update = event => {
      if (event.target !== popup) return;
      // Resolve the context tab, which can differ from the selected tab.
      const tab = contextTab = win.TabContextMenu?.contextTab;
      item.disabled = !canMoveTabToLittleZen(win, tab);
      item.setAttribute("tooltiptext", tab?.splitview
        ? "Remove this tab from its split view before moving it"
        : "Move this live tab into its own Little Zen window");
      const anchor = win.document.getElementById("context_moveTabOptions");
      popup.insertBefore(item, anchor?.parentNode === popup ? anchor : null);
    };
    popup.appendChild(item);
    popup.addEventListener("popupshowing", update);
    item.addEventListener("command", () => {
      moveTabToLittleZen(win, contextTab);
    });
  }

  function attachMainTabShortcut(win) {
    if (isLittleWindow(win) || win[PATCH_FLAGS.tabClickListener]) {
      return;
    }

    const onMouseDown = event => {
      const usesAccel =
        AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      const tab = event.target?.closest?.(".tabbrowser-tab");
      if (
        event.button !== 0 ||
        event.shiftKey ||
        !event.altKey ||
        !usesAccel ||
        !tab
      ) {
        return;
      }

      const url = tab.linkedBrowser?.currentURI?.spec;
      if (!url || url === "about:blank" || url === "about:newtab") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      LittleZen.openLittleWindow(win, {
        url,
        source: "ctrl-alt-tab-click",
        triggeringPrincipal: tab.linkedBrowser?.contentPrincipal,
      });
    };

    win.gBrowser?.tabContainer?.addEventListener("mousedown", onMouseDown, true);
    win[PATCH_FLAGS.tabClickListener] = true;
    log("Attached main-window Ctrl+Alt+tab click handling");
  }

  const LittleZen = {
    queueNavigation(win, url, meta = {}) {
      if (!url) {
        delete win.__littleZenSuppressUrlbarFocus;
        return;
      }

      win.__littleZenSuppressUrlbarFocus = true;
      markLittleWindowEarly(win, { url, meta });
      setLittleWindowLoading(win, true, "queue-navigation");
      closeLittleWindowUrlbar(win, "queue-navigation");
      routeLog("Queued Little Zen navigation", {
        url,
        source: meta.source ?? "unknown",
      });
      try {
        win.__littleZenRefreshSpacePickerTarget?.();
      } catch (error) {
        log("Could not refresh Little Zen routed workspace target", error);
      }

      if (win.__littleZenStartupReady) {
        schedulePendingNavigationFlush(win, "queue-navigation-ready");
        return;
      }

      logLittleWindowState(win, "Little Zen navigation waiting for delayed startup", {
        url,
        source: meta.source ?? "unknown",
      });

      whenStartupReady(win, () => {
        logLittleWindowState(
          win,
          "Little Zen navigation callback reached delayed startup",
          {
            url,
            source: meta.source ?? "unknown",
          }
        );
        schedulePendingNavigationFlush(win, "queue-navigation-startup");
      });
    },

    openLittleWindow(opener = window, options = {}) {
      const {
        url = null,
        source = "manual",
        triggeringPrincipal = null,
        expanded = false,
      } = options;
      log("Little Zen open request", {
        source,
        url,
      });
      let launchContext = null;
      if (AppConstants.platform === "macosx" &&
          (Services.prefs.getBoolPref("extensions.littleZen.focusWindowOnly", true) ||
           Services.prefs.getBoolPref("extensions.littleZen.returnToSourceApp", true)) &&
          (source.startsWith("browserDOMWindow.") || source.startsWith("external"))) {
        try { launchContext = getMacWindowFocusBridge()?.noteExternalOpen(); }
        catch (error) { log("Could not restore background Zen window order", error); }
      }

      for (const browserWindow of browserWindows()) {
        if (isEmptyLittleWindow(browserWindow)) {
          log("Reusing existing empty Little Zen window");
          if (expanded) {
            applyExpandedLittleWindow(browserWindow, "expanded-reuse");
          }
          if (AppConstants.platform === "macosx") getMacWindowFocusBridge()?.rememberLauncher?.(browserWindow, launchContext);
          this.queueNavigation(browserWindow, url, { source, triggeringPrincipal });
          focusLittleWindow(browserWindow);
          if (!url && !expanded) {
            delete browserWindow.__littleZenSuppressUrlbarFocus;
            focusUrlbar(browserWindow);
          }
          return browserWindow;
        }
      }

      if (typeof opener?.OpenBrowserWindow !== "function") {
        log("Cannot open Little Zen; OpenBrowserWindow missing");
        return null;
      }

      const littleWindow = opener.OpenBrowserWindow({
        zenLittleWindow: true,
        all: false,
        features: OPEN_FEATURES,
        url,
        expanded,
      });

      if (littleWindow) {
        if (AppConstants.platform === "macosx") getMacWindowFocusBridge()?.rememberLauncher?.(littleWindow, launchContext);
        this.queueNavigation(littleWindow, url, { source, triggeringPrincipal });
        if (expanded) {
          whenStartupReady(littleWindow, () => {
            applyExpandedLittleWindow(littleWindow, "expanded-request");
          });
        }
        focusLittleWindow(littleWindow);
      }

      return littleWindow;
    },
  };

  function bootstrapWindow(win) {
    if (!isBrowserWindow(win) || win[PATCH_FLAGS.window]) {
      return;
    }

    const redirectExternalStartup =
      !isLittleWindow(win) &&
      isExternalStartupWindow(win) &&
      [...browserWindows()].some(
        browserWindow => browserWindow !== win && !isLittleWindow(browserWindow)
      );
    if (redirectExternalStartup) {
      patchOpenBrowserWindow(win);
      const url = getExternalStartupUrl(win);
      if (url) {
        LittleZen.openLittleWindow(win, {
          url,
          source: "external-startup-window",
          expanded: true,
        });
        win.close();
        return;
      }
      log("External startup URL not available yet; waiting for browser startup");
    }

    win[PATCH_FLAGS.window] = true;
    win.LittleZen = LittleZen;

    patchAppLaunchCleanup();
    patchBrowserWindowTracker();
    patchUriLoadingHelper();
    patchBrowserDOMWindow(win);
    patchOpenBrowserWindow(win);
    patchContentLinkShortcut();
    attachMainTabShortcut(win);
    attachTabContextMenu(win);
    attachMacWindowOrderTracking(win);
    ensureFallbackShortcut(win);
    ensureCommand(win);

    // Intercept window.gZenUIManager assignment so the motion stub is installed
    // the instant Zen sets it — regardless of when that happens relative to our
    // script. ZenStartup creates gZenUIManager inside a setTimeout(..., 0) after
    // MozBeforeInitialXULLayout, so polling/event listeners are too late.
    if (!win.gZenUIManager && !win.__littleZenUIManagerIntercepted) {
      win.__littleZenUIManagerIntercepted = true;
      let _uiManager = undefined;
      Object.defineProperty(win, "gZenUIManager", {
        configurable: true,
        enumerable: true,
        get() { return _uiManager; },
        set(v) {
          _uiManager = v;
          // Restore normal property so future reads/writes are direct
          Object.defineProperty(win, "gZenUIManager", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: v,
          });
          // Install the motion stub immediately
          patchZenUIManager(win);
        },
      });
    } else if (win.gZenUIManager) {
      patchZenUIManager(win);
    }

    // Block mods that crash in the little window by intercepting gZenThemePicker.
    // BetterZenGradientPicker checks for this before initializing; keeping it
    // undefined in little windows prevents it from running where it has no panel.
    if (isLittleWindow(win) && !win.__littleZenThemePickerBlocked) {
      win.__littleZenThemePickerBlocked = true;
      if (!win.gZenThemePicker) {
        Object.defineProperty(win, "gZenThemePicker", {
          configurable: true,
          enumerable: true,
          get() { return undefined; },
          set(v) {
            // Silently swallow — theme picker has no panel in little windows
            Object.defineProperty(win, "gZenThemePicker", {
              configurable: true, enumerable: true, writable: true, value: undefined,
            });
          },
        });
      }
    }

    if (isLittleWindow(win)) {
      applyLittleWindowMode(win);
    }

    whenStartupReady(win, () => {
      attachTabContextMenu(win);
      log("Little Zen delayed startup reached");
      if (redirectExternalStartup) {
        let attempts = 0;
        const redirect = () => {
          if (win.closed) {
            return;
          }

          const url = getLittleWindowUrl(win);
          if (!url) {
            if (++attempts < 100) {
              win.setTimeout(redirect, 50);
            } else {
              log("External startup URL did not become available; keeping normal window");
            }
            return;
          }

          LittleZen.openLittleWindow(win, {
            url,
            source: "external-startup-window",
            expanded: true,
          });
          win.close();
        };
        redirect();
        return;
      }

      patchBrowserDOMWindow(win);
      ensureCommand(win);
      patchOpenBrowserWindow(win);
      patchCompactModeManager(win);
      patchVerticalTabsManager(win);
      patchZenUIManager(win);
      patchUrlbar(win);
      if (isLittleWindow(win)) {
        applyLittleWindowMode(win);
        if (win.__littleZenPendingURL) {
          schedulePendingNavigationFlush(win, "bootstrap-delayed-startup");
        }
      }
    });
  }

  bootstrapWindow(window);
  log("Little Zen runtime backport loaded.");
})();
