# Little Zen

Small, temporary Zen Browser windows for links opened from other apps. Read the page, close it, or use **Open in Space** to move the live tab into your main window.

This fork combines [wahyuabrory/little-zen](https://github.com/wahyuabrory/little-zen)'s installer and recent fixes with workspace routing, live-tab transfer, and macOS window improvements developed for this version.

## Features

- External links open in independent Little Zen windows with a minimal toolbar and no browser sidebar or tab strip.
- Zen's existing Space Routing rules determine the workspace and container before the page loads.
- **Open in Space** adopts the live tab instead of reopening its URL. The page retains JavaScript state, unsaved form values, scroll position, navigation history, and its existing cookie container. A failed adoption leaves the source window open.
- A compact split button provides an inline shortcut hint and a searchable destination picker with keyboard navigation.
- App-launch windows for Zoom/ZoomGov, Teams, Slack, Notion, Discord, and Linear close automatically shortly after an accepted native app handoff. Canceled prompts, launch errors, and navigation back to the website leave the window open.
- Window size and position are remembered between windows and browser restarts.
- Native macOS stoplight buttons remain visible beside the address bar.
- Closing a Little Zen window avoids briefly displaying Zen's start page. Connected pages still receive their unload checks.
- Toolbar-hover and address-popup fixes keep page content and controls aligned.

## Install

This is a privileged browser customization, not a normal Firefox add-on. It uses the bundled [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) loader and does not require Sine. Review the scripts before running them.

Quit Zen completely before installing. Back up your profile before updating an existing setup.

### macOS and Linux

Download and inspect the installer, then run it:

```sh
curl -fsSLo /tmp/little-zen-install.sh https://raw.githubusercontent.com/palexander/little-zen/main/install.sh
less /tmp/little-zen-install.sh
sh /tmp/little-zen-install.sh
```

On macOS, writing to `/Applications/Zen.app` can require administrator access and App Management permission for the terminal app running the installer. Follow the installer's instructions if it cannot write the loader files.

Linux tarball/system installations are supported by the inherited installer. Flatpak is not supported because the loader needs files inside the application installation.

### Windows

Download and inspect `install.ps1` from this repository, then run it in PowerShell:

```powershell
.\install.ps1
```

Administrator access may be needed for a protected Zen installation.

### Explicit paths or local installation

```sh
git clone https://github.com/palexander/little-zen.git
cd little-zen
./install.sh --profile "/path/to/zen/profile" --zen "/Applications/Zen.app"
```

On Linux, `--zen` is the directory containing the `zen` binary. Windows equivalents:

```powershell
.\install.ps1 -ProfilePath "C:\path\to\profile" -ZenPath "C:\Program Files\Zen Browser"
```

The loader files inside the application are install-wide, but Little Zen runs only in profiles containing its script. The installer refuses to overwrite a different application-level AutoConfig setup. Existing Little Zen script/style files are updated in place.

Start Zen after installation. If changes do not appear, use **about:support → Clear startup cache**, then restart.

## Use

| Action | Shortcut or control |
| --- | --- |
| Open an external link | Click it in another application with Zen set as the destination/default browser |
| Promote the loaded tab | **Open in Space**, or `Cmd+O` on macOS / `Ctrl+O` elsewhere |
| Choose a destination | The dropdown chevron, or `Cmd+Option+O` / `Ctrl+Alt+O` |
| Search the destination list | Type, use arrow keys and Enter; Escape dismisses the menu |
| Open a link/tab in Little Zen | `Cmd+Option+Click` on macOS / `Ctrl+Alt+Click` elsewhere |
| Close Little Zen | Native close button or the browser's close-tab shortcut |

The inherited blank-window shortcut is `Cmd+Option+N` / `Ctrl+Alt+N`; availability can depend on Zen shortcuts and the keyboard layout.

Automatic launch-page cleanup supports **Zoom/ZoomGov, Microsoft Teams (work and personal), Slack, Notion, Discord invites, and Linear**. It uses bundled [App Tab Cleaner presets](https://github.com/babraham123/app-tab-cleaner/blob/main/src/lib/presets.ts), plus an accepted native-app launch check. Zoom must also have its `#success` marker; Linear must have `noRedirect=1`. Teams supports `msteams:`, `ms-teams:`, and `web+msteams:`; its same-document launch-status flags may change without canceling cleanup. Changing the meeting destination or navigating to the web version cancels cleanup.

Set `extensions.littleZen.closeAppLaunchers=false` in `about:config` to disable cleanup globally. Each app has a boolean preference `extensions.littleZen.appLaunchers.<id>`: `zoom`, `teams`, `slack`, `notion`, `discord`, `linear`, `figma`, or `spotify`. Figma and Spotify default to **false** because their patterns also match normal web pages; set their preference to true to opt in. These preferences can be created in `about:config` if absent.

The close delay is `extensions.littleZen.appLaunchCloseDelayMs` (default 1800, minimum 500 milliseconds). A pending completion marker is watched for up to 10 seconds. Ordinary pages and extension login windows stay open. Cleanup requires Firefox to accept the native launch; it cannot verify that the app finished loading the destination.

## Compatibility and limitations

Validated on **Zen 1.23.4b on macOS**. Windows and Linux installers are inherited from upstream; their UI behavior has not been validated for this fork.

This code hooks internal Zen/Firefox APIs. Browser updates can change those APIs or replace the application-level loader files. The script stops itself if it detects Zen's native `ZenLittleWindow` module.

Live transfer is verified for ordinary web pages. PDF viewers, media/capture sessions, popups, and sites with unusual window-lifecycle behavior may need additional testing.

The inherited diagnostic logger writes navigation URLs to `little-zen-debug.log` in the profile. Avoid sharing that file unredacted. `extensions.littleZen.debugRouting=true` enables additional routing diagnostics. Saved window bounds use `extensions.littleZen.windowGeometry`.

## Remove

Quit Zen. Remove `chrome/JS/littleZen.uc.js`, `chrome/CSS/little-zen.css`, and its import from `chrome/userChrome.css` in the affected profile. If no other scripts use fx-autoconfig, its profile runtime and application loader files can also be removed. Do not remove a shared loader used by other customizations.

## Attribution and licensing

- Original project: [12th-devs/little-zen](https://github.com/12th-devs/little-zen).
- Installer, non-Sine backport, and subsequent fixes: [wahyuabrory/little-zen](https://github.com/wahyuabrory/little-zen).
- Native Little Zen work referenced by upstream: [zen-browser/desktop#13450](https://github.com/zen-browser/desktop/pull/13450).
- Loader: [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig); its license is retained under `vendor/fx-autoconfig/LICENSE`.

Upstream Little Zen does not currently provide a clear repository-wide open-source license. This fork preserves that status and does not assign a new license to upstream code. See [UPSTREAM.md](UPSTREAM.md) for source provenance and the licensing distinction.

Regression checks and developer instructions are in [tests/README.md](tests/README.md).
