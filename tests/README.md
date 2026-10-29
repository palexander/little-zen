# Regression checks

The Python integration runner launches a real Zen binary with a disposable profile and a local HTTP fixture. It does not load your everyday profile, copy login cookies, or contact GitHub.

Prerequisites: Python 3.10+, Zen, and the fx-autoconfig **application-level** loader already installed in that Zen installation. No Python packages are required. The script starts a temporary localhost Marionette endpoint for the test browser and terminates that browser afterward. Never use this test configuration for an everyday profile.

```sh
node --check littleZen.uc.js
sh -n install.sh
python3 tests/run.py --zen /Applications/Zen.app/Contents/MacOS/zen
```

Optional browser-chrome screenshot:

```sh
python3 tests/run.py --zen /Applications/Zen.app/Contents/MacOS/zen --screenshot /tmp/little-zen.png
```

The suite checks the real tab context menu on an unselected tab, preserves its live document/Space/container during a move into Little Zen, and verifies that null/throwing adoption failures retain the source. It also checks workspace/container assignment, no sidebar or main-window tab pollution, toolbar-hover layout, destination search and keyboard/mouse selection, live document/form/history/scroll/cookie preservation during adoption, original-container retention across Space changes, failure safety, and null-safe close handling with unload refusal. A real content-link click also exercises Firefox's native protocol dispatch into the patched chooser using a local web handler, without launching an external app. Launcher tests exercise Firefox's protocol chooser with a simulated native handler, checking all eight app presets, Zoom/Linear completion markers, per-app opt-ins, Teams host and protocol variants, same-document launch flags, changed meeting destinations, web-client exclusions, accepted and canceled prompts, launch errors, browser navigation, unrelated URLs/protocols, disabling the feature, unload refusal, and additional tabs. They do not launch Notion or another external app. Native macOS controls require a separate visual check because headless screenshots do not render AppKit buttons.

Validated on Zen 1.23.4b/macOS. PowerShell and Windows/Linux UI behavior have not been validated here.

## macOS activation regression

Run `python3 tests/macos_focus.py` from an interactive terminal. It launches two normal Zen windows in a disposable profile. Return to the terminal and press Enter when prompted. The test reproduces app-wide activation before opening Little Zen, then verifies the previous window order, unchanged window bounds, and actual keyboard focus. It also checks that a canceled close retains focus and that a canceled DOM close keeps focus and a confirmed close returns to the source app even after Little Zen loses native key-window status. Early handoff timing is checked only when its experimental preference is enabled. It briefly raises its own test windows and closes the owned browser afterward. It does not use or restart your everyday Zen profile. Headless checks cannot validate macOS window ordering.
