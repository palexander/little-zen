import AppKit
import Foundation
import Carbon
import Darwin

private let launcherID = "com.palexander.little-zen-launcher"
private let workspace = NSWorkspace.shared
private let arguments = Array(CommandLine.arguments.dropFirst())

private func option(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
private let zenURL = URL(fileURLWithPath: option("--zen") ?? "/Applications/Zen.app", isDirectory: true)
private let dataDirectory = URL(fileURLWithPath: option("--data-directory") ??
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("zen/little-zen-launcher", isDirectory: true).path, isDirectory: true)

private func report(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}
private func backgroundConfiguration() -> NSWorkspace.OpenConfiguration {
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    config.addsToRecentItems = false
    config.allowsRunningApplicationSubstitution = false
    return config
}
private func identity(_ app: NSRunningApplication?) -> [String: Any]? {
    guard let app, app.bundleIdentifier != launcherID, !app.isTerminated,
          let date = app.launchDate else { return nil }
    return ["pid": Int(app.processIdentifier), "launched": date.timeIntervalSince1970]
}

final class Launcher: NSObject, NSApplicationDelegate {
    private var pending: [(URL, [String: Any]?)] = []
    private var delivering = false
    private var commandMode = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if arguments.contains("--quit") {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: launcherID)
                where app.processIdentifier != ProcessInfo.processInfo.processIdentifier {
                app.terminate()
            }
            NSApp.terminate(nil)
        } else if arguments.contains("--status") {
            let handlers = ["http", "https"].reduce(into: [String: String]()) { result, scheme in
                let app = workspace.urlForApplication(toOpen: URL(string: scheme + "://example.com")!)
                result[scheme] = app?.path ?? "unknown"
            }
            if let json = try? JSONSerialization.data(withJSONObject: handlers, options: [.sortedKeys]),
               let text = String(data: json, encoding: .utf8) { print(text) }
            NSApp.terminate(nil)
        } else if arguments.contains("--set-default") || arguments.contains("--restore-zen") {
            let appURL = arguments.contains("--restore-zen") ? zenURL : Bundle.main.bundleURL
            setDefault(appURL, schemes: ["http", "https"])
        } else if arguments.contains("--forward") {
            commandMode = true
            let urls = arguments.compactMap { value -> URL? in
                guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
                return url
            }
            guard !urls.isEmpty else { report("No HTTP or HTTPS URL supplied"); exit(2) }
            enqueue(urls)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) { enqueue(urls) }

    private func setDefault(_ appURL: URL, schemes: [String]) {
        guard let scheme = schemes.first else { NSApp.terminate(nil); return }
        workspace.setDefaultApplication(at: appURL, toOpenURLsWithScheme: scheme) { error in
            DispatchQueue.main.async {
                if let error { report("Could not set \(scheme) handler: \(error.localizedDescription)"); exit(1) }
                self.setDefault(appURL, schemes: Array(schemes.dropFirst()))
            }
        }
    }

    private func enqueue(_ urls: [URL]) {
        // The agent never activates, so the foreground application remains the
        // link's origin. Capture it now, before any asynchronous startup work.
        let source = identity(workspace.frontmostApplication)
        for url in urls where ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            pending.append((url, source))
        }
        deliverNext()
    }

    private func deliverNext() {
        guard !delivering, let next = pending.first else { return }
        delivering = true
        guard let bundleID = Bundle(url: zenURL)?.bundleIdentifier, bundleID != launcherID else {
            fail("Zen application not found at \(zenURL.path)"); return
        }
        let applicationINI = zenURL.appendingPathComponent("Contents/Resources/application.ini")
        let versionLine = (try? String(contentsOf: applicationINI, encoding: .utf8))?
            .components(separatedBy: .newlines).first { $0.hasPrefix("MaxVersion=") }
        guard let versionLine,
              let majorString = versionLine.dropFirst("MaxVersion=".count).split(separator: ".").first,
              let major = Int(majorString), major >= 160 else {
            fail("Background link opening requires a Zen build based on Firefox 160 or newer."); return
        }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first { $0.bundleURL?.standardizedFileURL == zenURL.standardizedFileURL && !$0.isTerminated }
        if let running, isReady(running) {
            forward(next)
            return
        }
        let config = backgroundConfiguration()
        config.environment = ["LITTLE_ZEN_LAUNCHER_DIRECTORY": dataDirectory.path]
        if let profile = option("--test-profile") {
            guard bundleID == "com.palexander.little-zen-test" else {
                fail("--test-profile requires the isolated test application"); return
            }
            config.arguments = ["-no-remote", "-profile", profile, "--marionette", "about:blank"]
            if arguments.contains("--test-headless") { config.arguments.append("-headless") }
            config.environment["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"
        }
        workspace.openApplication(at: zenURL, configuration: config) { app, error in
            DispatchQueue.main.async {
                guard let app, error == nil else { self.fail(error?.localizedDescription ?? "Zen did not start"); return }
                self.waitForReady(app, next: next, deadline: Date().addingTimeInterval(30))
            }
        }
    }

    private func isReady(_ app: NSRunningApplication) -> Bool {
        let marker = dataDirectory.appendingPathComponent("ready-\(app.processIdentifier).json")
        guard let data = try? Data(contentsOf: marker),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["version"] as? Int == 1,
              let started = json["started"] as? String else { return false }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(app.processIdentifier, PROC_PIDTBSDINFO, 0, &info, size) == size else { return false }
        return !app.isTerminated && started == "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
    }

    private func waitForReady(_ app: NSRunningApplication, next: (URL, [String: Any]?), deadline: Date) {
        if isReady(app) {
            forward(next); return
        }
        guard !app.isTerminated, Date() < deadline else {
            fail("Little Zen did not become ready. Update its browser script and fully restart Zen."); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.waitForReady(app, next: next, deadline: deadline)
        }
    }

    private func forward(_ next: (URL, [String: Any]?)) {
        var contextFile: URL?
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
            let file = dataDirectory.appendingPathComponent("request-\(UUID().uuidString).json")
            var record: [String: Any] = ["version": 1, "url": next.0.absoluteString,
                                       "at": Date().timeIntervalSince1970 * 1000]
            if let source = next.1 { record["sourceApp"] = source }
            let bytes = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            // Create with restrictive permissions before putting any URL on disk.
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw NSError(domain: "LittleZenLauncher", code: 1)
            }
            try bytes.write(to: file)
            contextFile = file
        } catch { fail("Could not prepare link handoff: \(error.localizedDescription)"); return }
        workspace.open([next.0], withApplicationAt: zenURL, configuration: backgroundConfiguration()) { _, error in
            DispatchQueue.main.async {
                if let error {
                    if let file = contextFile { try? FileManager.default.removeItem(at: file) }
                    self.fail("Could not send link to Zen: \(error.localizedDescription)")
                    return
                }
                self.pending.removeFirst()
                self.delivering = false
                if self.pending.isEmpty && self.commandMode { NSApp.terminate(nil) }
                else { self.deliverNext() }
            }
        }
    }

    private func fail(_ message: String) {
        report(message)
        if commandMode { exit(1) }
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Little Zen could not open the link"
        alert.informativeText = message
        alert.runModal()
        NSApp.setActivationPolicy(.prohibited)
        pending.removeAll()
        delivering = false
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let delegate = Launcher()
app.delegate = delegate
app.run()
