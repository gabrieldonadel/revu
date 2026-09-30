// revu's one native module (exact2 LLP 1067.000): local notifications on
// Apple through `UNUserNotificationCenter`, asked over `native.later`, with
// the user's answer coming back as a device change (`context.changed`,
// LLP 1016.002) that a watching source drains.
//
// The `revu-notifier` view exists because the Apple module artifact is only
// built for an app whose roster names a tag; it draws nothing.
//
// On macOS the same module owns the menu bar item (LLP 0006): the host's
// window becomes the popover under the item, shown on a click and hidden
// when the app loses focus; the Dock icon goes (accessory policy). The app
// keeps the item's count and spinner current over `native.call({op:"tray"})`.
//
// Under the agent (`context.agent`) the OS is never asked: permission is
// granted, a notification is remembered, `simulate` plays a user's answer
// back through the same change path, and no menu bar item is made, so a
// drive is repeatable and never prompts (LLP 1067.000 Q7).
import Foundation
import UserNotifications
#if os(macOS)
import AppKit
#else
import UIKit
#endif

final class Notifier: ExactModule {
    override class var views: [String: ExactNativeFactory] {
        ["revu-notifier": ExactNativeFactory(for: Notifier.self) { _, _, events in NotifierView(events: events) }]
    }

    private struct Pending {
        let notificationId: String
        let actionId: String
        let data: [String: Any]
    }

    private var pending: [Pending] = []
    private var records: [String: [String: Any]] = [:] // id → the data the app attached
    private var categories: [String: UNNotificationCategory] = [:]
    private var delegate: Delegate?
    private var permission = "not-determined"
    private var remembered: [[String: Any]] = [] // the agent's notifications
    private let lock = NSLock()
    /// This session's window: "popover" for the first, else the kind the
    /// popover asked for (`window` op) — "settings" today (LLP 0006 D2).
    private(set) var role = "popover"
    #if os(macOS)
    private var menuBar: MenuBar?
    private var secondary: SecondaryWindow?
    #endif

    required init(context: ExactModuleContext) {
        super.init(context: context)
        if context.agent { permission = "granted" }
        #if os(macOS)
        if !context.agent, Bundle.main.bundleIdentifier != nil {
            if MenuBar.shared == nil {
                menuBar = MenuBar()
                MenuBar.shared = menuBar
                Sidecar.startIfNeeded()
            } else {
                role = MenuBar.pendingRole ?? "window"
                MenuBar.pendingRole = nil
                secondary = SecondaryWindow(kind: role)
            }
        }
        #endif
        refreshPermission()
    }

    /// The standing answer, read from the center: a decision from an earlier
    /// launch is still the answer, and `status` must not report the default.
    private func refreshPermission() {
        guard !context.agent, available else { return }
        installDelegate()
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            guard let self else { return }
            let current = Notifier.permissionString(settings.authorizationStatus)
            if current != self.permission {
                self.permission = current
                self.context.changed("notifications")
            }
        }
    }

    // MARK: cheap queries (main thread, inside the asking answer's budget)

    override func call(_ request: [String: Any]) throws -> [String: Any] {
        switch request["op"] as? String {
        case "status":
            refreshPermission()
            return ["available": available, "permission": permission, "pending": pendingCount]
        case "drain":
            return ["actions": drain()]
        case "tray":
            return tray(request)
        case "role":
            return ["kind": role]
        case let op:
            throw ExactNativeRefusal("the notifier answers no call \(op.map { "\"\($0)\"" } ?? "null")")
        }
    }

    // MARK: long calls

    override func later(_ request: [String: Any], reply: ExactReply) {
        switch request["op"] as? String {
        case "status":
            reply.send(["available": available, "permission": permission, "pending": pendingCount])
        case "permission":
            requestPermission(reply: reply)
        case "notify":
            notify(request, reply: reply)
        case "close":
            close(request["id"] as? String ?? "")
            reply.send(["ok": true])
        case "drain":
            reply.send(["actions": drain()])
        case "tray":
            reply.send(tray(request))
        case "role":
            reply.send(["kind": role])
        case "window":
            // A window of a kind: shown if it exists, else opened through the
            // host's own New Window (a second session of the same plan) whose
            // module instance takes the pending role.
            #if os(macOS)
            guard let menuBar else { return reply.fail("windows are the popover's to open") }
            let kind = request["kind"] as? String ?? "settings"
            reply.send(["ok": menuBar.openWindow(kind: kind)])
            #else
            reply.fail("no windows here")
            #endif
        case "simulate":
            // The agent's stand-in for the user pressing an action.
            guard context.agent else { return reply.fail("simulate is the agent's") }
            let id = request["id"] as? String ?? ""
            let action = request["actionId"] as? String ?? "default"
            deliver(notificationId: id, actionId: action)
            reply.send(["ok": true])
        case let op:
            reply.fail("the notifier answers no \(op.map { "\"\($0)\"" } ?? "null")")
        }
    }

    override func destroy() {
        // Categories are process-wide; leave delivered notifications alone.
    }

    /// The menu bar item's count and spinner (design 1b/1d).
    private func tray(_ request: [String: Any]) -> [String: Any] {
        let count = request["count"] as? Int ?? Int(request["count"] as? Double ?? 0)
        let busy = request["busy"] as? Bool ?? false
        #if os(macOS)
        guard let menuBar else { return ["ok": false, "reason": context.agent ? "agent" : "no bundle"] }
        menuBar.update(count: count, busy: busy)
        return ["ok": true]
        #else
        return ["ok": false, "reason": "no menu bar"]
        #endif
    }

    // MARK: the OS

    /// `UNUserNotificationCenter.current()` raises, not throws, for a process
    /// with no bundle identifier; an unbundled host degrades to "unavailable".
    private var available: Bool { context.agent || Bundle.main.bundleIdentifier != nil }

    private var pendingCount: Int {
        lock.lock(); defer { lock.unlock() }
        return pending.count
    }

    private func installDelegate() {
        guard !context.agent, delegate == nil, available, role == "popover" else { return }
        let d = Delegate(owner: self)
        delegate = d
        UNUserNotificationCenter.current().delegate = d
    }

    private static func permissionString(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not-determined"
        @unknown default: return "not-determined"
        }
    }

    private func requestPermission(reply: ExactReply) {
        if context.agent { permission = "granted"; return reply.send(["permission": permission]) }
        guard available else { permission = "denied"; return reply.send(["permission": permission]) }
        installDelegate()
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            let current = Notifier.permissionString(settings.authorizationStatus)
            // Once decided, `requestAuthorization` silently returns the standing
            // answer without a prompt; report that rather than implying one.
            guard settings.authorizationStatus == .notDetermined else {
                self.permission = current
                return reply.send(["permission": current])
            }
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                // A request that itself fails leaves the status undetermined.
                self.permission = error != nil ? "not-determined" : (granted ? "granted" : "denied")
                reply.send(["permission": self.permission])
            }
        }
    }

    private func notify(_ request: [String: Any], reply: ExactReply) {
        guard let id = request["id"] as? String, !id.isEmpty else { return reply.fail("notify needs an id") }
        let data = request["data"] as? [String: Any] ?? [:]
        lock.lock(); records[id] = data; lock.unlock()

        if context.agent {
            remembered.append(request)
            return reply.send(["id": id, "delivered": "remembered"])
        }
        guard available else { return reply.fail("notifications need a bundled app") }
        installDelegate()

        let content = UNMutableNotificationContent()
        content.title = request["title"] as? String ?? ""
        if let body = request["body"] as? String { content.body = body }
        if let subtitle = request["subtitle"] as? String { content.subtitle = subtitle }
        if let sound = request["sound"] as? String {
            content.sound = sound == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(sound))
        }
        if let actions = request["actions"] as? [[String: Any]], !actions.isEmpty {
            let list: [UNNotificationAction] = actions.compactMap { entry in
                guard let aid = entry["id"] as? String, let title = entry["title"] as? String else { return nil }
                let destructive = entry["destructive"] as? Bool ?? false
                return UNNotificationAction(identifier: aid, title: title, options: destructive ? [.destructive] : [])
            }
            let categoryId = "dev.donadel.revu.\(id)"
            categories[categoryId] = UNNotificationCategory(identifier: categoryId, actions: list, intentIdentifiers: [], options: [.customDismissAction])
            UNUserNotificationCenter.current().setNotificationCategories(Set(categories.values))
            content.categoryIdentifier = categoryId
        }
        let requestToAdd = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(requestToAdd) { error in
            if let error { reply.fail("notification failed: \(error.localizedDescription)") } else { reply.send(["id": id, "delivered": "posted"]) }
        }
    }

    private func close(_ id: String) {
        guard !id.isEmpty else { return }
        lock.lock(); records.removeValue(forKey: id); lock.unlock()
        if context.agent { remembered.removeAll { ($0["id"] as? String) == id }; return }
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
        retireCategory(for: id)
    }

    private func retireCategory(for id: String) {
        let categoryId = "dev.donadel.revu.\(id)"
        if categories.removeValue(forKey: categoryId) != nil, !context.agent, available {
            UNUserNotificationCenter.current().setNotificationCategories(Set(categories.values))
        }
    }

    /// The user answered (any thread): remember it and announce the change;
    /// the watching source drains it on the runner's side.
    fileprivate func deliver(notificationId: String, actionId: String) {
        lock.lock()
        let data = records.removeValue(forKey: notificationId) ?? [:]
        pending.append(Pending(notificationId: notificationId, actionId: actionId, data: data))
        lock.unlock()
        DispatchQueue.main.async {
            self.retireCategory(for: notificationId)
            #if os(macOS)
            if actionId == "open" || actionId == "default" { self.menuBar?.show() }
            #endif
        }
        context.changed("notifications")
    }

    private func drain() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let out = pending.map { ["notificationId": $0.notificationId, "actionId": $0.actionId, "data": $0.data] as [String: Any] }
        pending.removeAll()
        return out
    }

    /// The center's delegate, separate so the module stays a plain object.
    private final class Delegate: NSObject, UNUserNotificationCenterDelegate {
        weak var owner: Notifier?
        init(owner: Notifier) { self.owner = owner }

        // Without this macOS hides banners while the app is frontmost.
        func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void) {
            handler([.banner, .list, .sound])
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler handler: @escaping () -> Void) {
            let id = response.notification.request.identifier
            let action: String
            switch response.actionIdentifier {
            case UNNotificationDismissActionIdentifier: action = "dismissed"
            case UNNotificationDefaultActionIdentifier: action = "default"
            default: action = response.actionIdentifier
            }
            owner?.deliver(notificationId: id, actionId: action)
            handler()
        }
    }
}

#if os(macOS)
import ObjectiveC

/// The menu bar item and the popover it opens (design 1b: the pull-request
/// icon with the pending count; 1d: a spinner while a review runs). The
/// popover is the host's own window, restyled: no title bar or buttons,
/// floating, hidden when the app deactivates, placed under the item. It is
/// never closed — closing ends the session (ExactMac's `windowWillClose`).
final class MenuBar: NSObject {
    static var shared: MenuBar?
    /// The role the next module instance (the next window's session) takes.
    static var pendingRole: String?
    /// Windows by kind, kept across hides.
    static var windows: [String: SecondaryWindow] = [:]

    private let item: NSStatusItem
    private var spinner: NSProgressIndicator?
    private(set) weak var popover: NSWindow?
    private let icon: NSImage
    private var count = 0
    private var busy = false
    private static let width: CGFloat = 380
    private static let height: CGFloat = 600

    override init() {
        icon = MenuBar.pullRequestIcon()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        NSApp.setActivationPolicy(.accessory)
        MenuBar.keepRunningWithoutWindows()
        if let button = item.button {
            button.image = icon
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "revu — review requests"
        }
        // The host's window exists by now (the module loads after first pixel);
        // adopt it once the current turn of the run loop is done with it, and
        // show it once the item has a place in the bar.
        DispatchQueue.main.async { [weak self] in
            self?.adoptWindow()
            self?.show(attempt: 0)
        }
    }

    /// ExactMac's delegate quits when its last window closes, and AppKit
    /// runs that check when the last visible window is *hidden* too — which
    /// is what a popover does. An accessory app lives in the bar; it quits
    /// from the item's menu or ⌘Q. So the delegate's answer becomes "no".
    private static func keepRunningWithoutWindows() {
        guard let delegate = NSApp.delegate else { return }
        let sel = #selector(NSApplicationDelegate.applicationShouldTerminateAfterLastWindowClosed(_:))
        // An IMP block takes self and the arguments, not the selector.
        let no: @convention(block) (AnyObject, NSApplication) -> Bool = { _, _ in false }
        let imp = imp_implementationWithBlock(no)
        let cls: AnyClass = type(of: delegate)
        if let method = class_getInstanceMethod(cls, sel) {
            method_setImplementation(method, imp)
        } else {
            class_addMethod(cls, sel, imp, "B@:@")
        }
    }

    private func adoptWindow() {
        guard popover == nil else { return }
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && !($0 is NSPanel) }) ?? NSApp.windows.first(where: { $0.contentView != nil && !($0 is NSPanel) }) else { return }
        popover = window
        window.setFrameAutosaveName("")
        window.styleMask = [.titled, .fullSizeContentView]
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbar = nil
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = true }
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.level = .floating
        window.hidesOnDeactivate = true
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        window.hasShadow = true
        window.setContentSize(NSSize(width: MenuBar.width, height: MenuBar.height))
    }

    /// Under the item, centred on it, on the item's screen. False until the
    /// item has a window in the bar.
    @discardableResult
    private func place() -> Bool {
        guard let window = popover else { return false }
        let size = window.frame.size
        guard let button = item.button, let buttonWindow = button.window, let screen = buttonWindow.screen ?? NSScreen.main else { return false }
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        // Before the bar has laid the item out its window sits at the origin;
        // an anchor outside the menu bar band is not the item's place yet.
        guard anchor.minY > screen.frame.maxY - 60 else { return false }
        var x = anchor.midX - size.width / 2
        let visible = screen.visibleFrame
        x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
        let y = anchor.minY - size.height - 6
        window.setFrameOrigin(NSPoint(x: x.rounded(), y: max(y, visible.minY).rounded()))
        return true
    }

    func show(attempt: Int = 0) {
        adoptWindow()
        guard let window = popover else { return }
        if !place(), attempt < 60 {
            // The bar has not placed the item yet; try again shortly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.show(attempt: attempt + 1) }
            return
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        item.button?.highlight(true)
    }

    func hide() {
        popover?.orderOut(nil)
        item.button?.highlight(false)
    }

    @objc private func clicked(_ sender: Any?) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: "Open revu", action: #selector(openFromMenu), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Settings…", action: #selector(settingsFromMenu), keyEquivalent: ",").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit revu", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
            return
        }
        if let window = popover, window.isVisible, window.isKeyWindow { hide() } else { show() }
    }

    @objc private func openFromMenu() { show() }
    @objc private func settingsFromMenu() { _ = openWindow(kind: "settings") }

    /// A window of a kind (design 1f: settings at 880 × 640): shown again if
    /// it is open, else the host opens a New Window — a second session of the
    /// plan — and that session's module instance takes the kind as its role.
    func openWindow(kind: String) -> Bool {
        if let existing = MenuBar.windows[kind] {
            existing.show()
            return true
        }
        MenuBar.pendingRole = kind
        let opened = NSApp.sendAction(#selector(NSResponder.newWindowForTab(_:)), to: nil, from: nil)
        if !opened { MenuBar.pendingRole = nil }
        return opened
    }

    func update(count: Int, busy: Bool) {
        guard self.count != count || self.busy != busy else { return }
        self.count = count
        self.busy = busy
        guard let button = item.button else { return }
        let title = count > 0 ? " \(count)" : ""
        button.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
            .baselineOffset: 0.5,
        ])
        if busy {
            if spinner == nil {
                let s = NSProgressIndicator(frame: NSRect(x: 6, y: (button.bounds.height - 16) / 2, width: 16, height: 16))
                s.style = .spinning
                s.controlSize = .small
                s.isIndeterminate = true
                s.autoresizingMask = [.minYMargin, .maxYMargin]
                button.addSubview(s)
                s.startAnimation(nil)
                spinner = s
            }
            // A blank image keeps the icon's room while the spinner sits over it.
            button.image = MenuBar.blank(icon.size)
        } else {
            spinner?.stopAnimation(nil)
            spinner?.removeFromSuperview()
            spinner = nil
            button.image = icon
        }
    }

    /// Lucide's `git-pull-request`, 16 pt, as a template image.
    private static func pullRequestIcon() -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: true) { _ in
            NSColor.black.setStroke()
            let scale = 16.0 / 24.0
            let t = NSAffineTransform()
            t.scale(by: scale)
            t.concat()
            func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) {
                let p = NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
                p.lineWidth = 2
                p.stroke()
            }
            circle(18, 18, 3)
            circle(6, 6, 3)
            let arm = NSBezierPath()
            arm.move(to: NSPoint(x: 13, y: 6))
            arm.line(to: NSPoint(x: 16, y: 6))
            arm.curve(to: NSPoint(x: 18, y: 8), controlPoint1: NSPoint(x: 17.1, y: 6), controlPoint2: NSPoint(x: 18, y: 6.9))
            arm.line(to: NSPoint(x: 18, y: 15))
            arm.lineWidth = 2
            arm.lineCapStyle = .round
            arm.lineJoinStyle = .round
            arm.stroke()
            let trunk = NSBezierPath()
            trunk.move(to: NSPoint(x: 6, y: 9))
            trunk.line(to: NSPoint(x: 6, y: 21))
            trunk.lineWidth = 2
            trunk.lineCapStyle = .round
            trunk.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func blank(_ size: NSSize) -> NSImage {
        let image = NSImage(size: size, flipped: false) { _ in true }
        image.isTemplate = true
        return image
    }
}

/// The packaged sidecar (LLP 0007): `revu.app/Contents/Resources/revu-sidecar`,
/// a compiled Bun binary, started by the app when nothing answers on the
/// loopback port, and stopped when the app quits. A sidecar started by hand
/// (`bun run sidecar`) is left alone.
enum Sidecar {
    private static var process: Process?

    static func startIfNeeded() {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("revu-sidecar"),
              FileManager.default.isExecutableFile(atPath: url.path) else { return }
        health { alive in
            guard !alive, process == nil else { return }
            let p = Process()
            p.executableURL = url
            p.currentDirectoryURL = url.deletingLastPathComponent()
            var env = ProcessInfo.processInfo.environment
            env["REVU_PACKAGED"] = "1"
            env["PATH"] = [env["PATH"] ?? "", "\(NSHomeDirectory())/.local/bin", "\(NSHomeDirectory())/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"].joined(separator: ":")
            p.environment = env
            let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/revu-sidecar.log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            if let handle = try? FileHandle(forWritingTo: log) {
                handle.seekToEndOfFile()
                p.standardOutput = handle
                p.standardError = handle
            }
            do {
                try p.run()
                process = p
                NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
                    process?.terminate()
                }
            } catch {
                NSLog("revu: the sidecar did not start: %@", error.localizedDescription)
            }
        }
    }

    private static func health(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:47831/health") else { return done(false) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let alive = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(alive) }
        }.resume()
    }
}

/// A second window of the app (design 1f, 880 × 640): the host's New Window,
/// restyled — title bar transparent so the app's own tab bar is the toolbar,
/// the traffic lights kept. Its close button hides it (the session stays, so
/// the next open is instant); ⌘W still closes it, and the next open boots
/// a fresh session.
final class SecondaryWindow: NSObject {
    let kind: String
    private(set) weak var window: NSWindow?

    init(kind: String) {
        self.kind = kind
        super.init()
        MenuBar.windows[kind] = self
        DispatchQueue.main.async { [weak self] in self?.adopt() }
    }

    private func adopt() {
        guard window == nil else { return }
        let taken = Set(MenuBar.windows.values.compactMap { $0.window }.map { ObjectIdentifier($0) })
        let popover = MenuBar.shared?.popover
        guard let w = NSApp.windows.last(where: { $0.contentView != nil && !($0 is NSPanel) && $0 !== popover && !taken.contains(ObjectIdentifier($0)) }) else { return }
        window = w
        w.setFrameAutosaveName("")
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.title = "revu — \(kind.capitalized)"
        w.toolbar = nil
        w.isMovable = true
        w.level = .normal
        w.hidesOnDeactivate = false
        w.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        w.tabbingMode = .disallowed
        w.contentMinSize = NSSize(width: 720, height: 520)
        w.setContentSize(NSSize(width: 880, height: 640))
        w.center()
        if let close = w.standardWindowButton(.closeButton) {
            close.target = self
            close.action = #selector(hide)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(closed(_:)), name: NSWindow.willCloseNotification, object: w)
        show()
    }

    func show() {
        guard let w = window else { return }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func hide() { window?.orderOut(nil) }

    @objc private func closed(_ note: Notification) {
        if MenuBar.windows[kind] === self { MenuBar.windows.removeValue(forKey: kind) }
    }
}
#endif

/// The roster's view: nothing to draw, nothing to measure.
final class NotifierView: ExactNativeInstance {
    private let box: ExactNativeView
    override init(events: ExactNativeEvents) {
        box = ExactNativeView(frame: .zero)
        #if os(macOS)
        box.isHidden = true
        #else
        box.isHidden = true
        #endif
        super.init(events: events)
        events.load()
    }
    override var view: ExactNativeView { box }
}

let exactModule: ExactModule.Type = Notifier.self
