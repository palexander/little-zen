# Reducing the external-link opening flash on macOS

Research checked October 29, 2026. The installed Zen build reports Gecko **158.0.1**, build `20261020090730`.

## Why repairing window order cannot prevent every flash

Our current integration receives the link after native application activation can already have raised Zen's windows. Restoring their previous order corrects the final stack, but cannot undo a frame already displayed. Preventing that initial activation requires cooperation earlier in the launch path.

There is also a relevant upstream regression: [Mozilla bug 2081443](https://bugzilla.mozilla.org/show_bug.cgi?id=2081443) documents Firefox 158 activating on background URL opens. It is marked fixed for Firefox 160 and wontfix for 158/159. Zen's installed `BrowserContentHandler.sys.mjs` does not have the newer `url-background` path. The [current Mozilla native URL handler](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/xre/MacApplicationDelegate.mm) distinguishes background AppleEvents and forwards them with that flag. This means an ordinary background-launch wrapper needs validation on this Zen build, not just a background option in its own code.

## Options

| Approach | Benefits | Requirements and limitations |
| --- | --- | --- |
| Small macOS URL-launcher agent | Receive external links without a normal browser window; ask Zen to open the URL without application activation, then let Little Zen raise only its own window. Keeps existing Spaces/routing inside Zen. | A separate app selected as the HTTP/HTTPS handler, and a working background dispatch path in Zen. Validate cold starts, multiple links, and source-app identity. |
| Source app opens links in background | No separate handler where the source app offers this behavior. | Coverage depends on the source app; the Gecko 158 regression still matters. |
| Native Zen integration/backport | Put background URL handling and Little Zen activation in the browser's own native pipeline. | Requires a browser build/maintained patch or a Zen release incorporating the appropriate upstream fix. The full opening flow still needs native testing. |
| More JavaScript timing/window-order repairs | Fits the existing installation. | Can reduce artifacts but cannot guarantee no initial flash after native activation has already occurred. |

Apple provides [NSWorkspace.OpenConfiguration.activates](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/activates) to control activation when forwarding URLs, and [LSUIElement](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement) for an agent app without a Dock icon. Those APIs support the launcher design; they do not prove the entire Zen path is flash-free.

## Recommendation

Prototype the small launcher only after verifying or backporting background URL handling on the target Zen build. A launcher plus working background dispatch is the most practical way to prevent ordinary Zen activation before Little Zen exists. Prefer that supported path over replacing AppKit methods at runtime or altering all browser focus behavior globally.

This research did **not** install a launcher, change the default browser, alter Zen's native binaries, or enable a global focus preference.

## Implemented launcher, November 19, 2026

Zen 1.24.3b reports Gecko 160.0.1. `macos/LittleZenLauncher.swift` now implements the optional background URL agent using `NSWorkspace.OpenConfiguration.activates = false`. Its build/install scripts compile locally and register the app without changing the default browser; handler activation and restoration are explicit commands.

The browser publishes readiness after startup using its PID and kernel process-start timestamp. This avoids relying on `NSRunningApplication.launchDate`, which can be absent for a command-line launch. The agent waits for a matching live-process marker before forwarding a URL. A private, temporary handoff record retains the original app identity across asynchronous cold startup; Zen consumes it once by matching the URL and leaves workspace/container routing inside Little Zen.

The native warm-start test opened a real local fixture through NSWorkspace, retained existing window order and bounds throughout 90 samples, gave Little Zen native keyboard focus, and returned to the same source app on close. A visible cold start also opened the fixture in Little Zen, received focus and returned to the source app. One earlier visible cold-start automation attempt timed out; a subsequent instrumented run completed in 2.68 seconds. Headless cold-start and two-link routing checks also passed. These results support installing the implementation, but do not guarantee zero transient frames under every startup condition.

The optional agent does not alter Zen's native binaries. Its private handoff/readiness files live outside the browser profile under `UAppData/little-zen-launcher`; URLs are consumed on delivery, and expired handoffs are removed when a subsequent handoff is read. The previous in-memory order-repair fallback remains available for direct external links that bypass the agent.
