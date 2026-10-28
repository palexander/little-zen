# Source provenance

This repository is a GitHub fork of `wahyuabrory/little-zen`.

| Component | Source revision |
| --- | --- |
| Fork starting point / installers | `wahyuabrory/little-zen` at `f1ed4b1109ae7ac8fac58b3dec6652a4bee556da` (2026-10-06) |
| Previously installed browser-script/style baseline | `12th-devs/little-zen` at `96d94d5e1769f78f91880c7047d5af495fd17716` (2026-09-23), with the local changes carried into this fork |
| Bundled fx-autoconfig runtime | `MrOtherGuy/fx-autoconfig` at `dfdab5684faffc112b76ccb1d8cab7f75da0102c` |

The combined script/style retain the local workspace/container routing, startup ordering, window geometry, native macOS controls, close handling, and live tab adoption. The October 6 upstream picker fixes (key handling, search labels, hover selection, and Escape), hover-layout fix, and address-popover alignment have been incorporated. An inherited early-startup double-Escape edge case is also corrected. Theme detection is adapted to use the main window while respecting an explicitly selected light/dark scheme. Upstream's broader restyling, routing bypass, and URL-reopening promotion behavior are not used.

## License status

Neither Little Zen repository supplies a clear root-level license grant at the revisions listed above. The older `12th-devs/little-zen/window/README.md` says the code is provided as-is for Zen modifications, but does not provide a standard open-source license. Some upstream material references Zen's MPL-2.0 implementation; that alone does not establish licensing for all subsequent additions.

This fork does not claim a new license for that upstream material. Existing notices and the separately licensed fx-autoconfig license are preserved. GitHub's platform permission to fork a public repository is distinct from a general open-source redistribution license. Clarification from the upstream authors is still needed before representing the entire project as permissively licensed.

## App-launch URL presets

Patterns are adapted from [App Tab Cleaner](https://github.com/babraham123/app-tab-cleaner), commit `ac355984c7e9e7d73862b569355c20b510ddcf1a`, `src/lib/presets.ts`. The original source snapshot and MIT copyright/permission notice are retained in `vendor/app-tab-cleaner/`. Protocol matching, accepted-launch checks, completion-marker waiting, and window lifecycle guards are Little Zen integration code. Presets are bundled locally; no remote rule downloads run in the browser.
