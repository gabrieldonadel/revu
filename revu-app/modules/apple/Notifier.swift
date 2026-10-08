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
    /// The role's argument (a review window's job id).
    private(set) var roleArg = ""
    #if os(macOS)
    private var menuBar: MenuBar?
    private var secondary: SecondaryWindow?
    #endif

    /// The APNs device token (hex), once the OS has handed one over (LLP 0009).
    fileprivate(set) static var pushToken = ""
    fileprivate static var pushTokenOwner: Notifier?

    required init(context: ExactModuleContext) {
        super.init(context: context)
        if context.agent { permission = "granted" }
        #if os(macOS)
        if !context.agent, Bundle.main.bundleIdentifier != nil {
            if MenuBar.shared == nil {
                menuBar = MenuBar()
                MenuBar.shared = menuBar
                Sidecar.startIfNeeded()
                Notifier.pushTokenOwner = self
                RemotePush.registerIfEntitled()
            } else {
                role = MenuBar.pendingRole ?? "window"
                roleArg = MenuBar.pendingArg ?? ""
                MenuBar.pendingRole = nil
                MenuBar.pendingArg = nil
                secondary = SecondaryWindow(kind: role, arg: roleArg)
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
            return ["kind": role, "arg": roleArg]
        case "pushToken":
            return ["token": Notifier.pushToken, "entitled": RemotePush.entitled]
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
            reply.send(["kind": role, "arg": roleArg])
        case "window":
            // A window of a kind: shown if it exists, else opened through the
            // host's own New Window (a second session of the same plan) whose
            // module instance takes the pending role.
            #if os(macOS)
            guard let menuBar else { return reply.fail("windows are the popover's to open") }
            let kind = request["kind"] as? String ?? "settings"
            let arg = request["arg"] as? String ?? ""
            reply.send(["ok": menuBar.openWindow(kind: kind, arg: arg)])
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
/// popover is a real `NSPopover` (as Orbit's, Gabriel 2026-10-02): the
/// system's arrow, vibrancy and corners, transient — it closes itself when
/// the user clicks elsewhere. Its content is the host's own `ExactView`,
/// moved out of ExactMac's window (which stays alive and ordered out,
/// never closed: closing ends the session) into a view controller the
/// popover owns. The view pauses its rasters while it has no window and
/// resumes when it lands in the popover's (ExactViewMac.viewDidMoveToWindow).
final class MenuBar: NSObject, NSPopoverDelegate {
    static var shared: MenuBar?
    /// The role (and its argument) the next module instance — the next window's session — takes.
    static var pendingRole: String?
    static var pendingArg: String?
    /// Windows by kind, kept across hides.
    static var windows: [String: SecondaryWindow] = [:]

    /// The Dock icon follows the windows (Gabriel, 2026-10-01): a menu bar app
    /// with only its popover has none; while a Settings or Review window is
    /// visible the app is a regular one, with a Dock tile to find it by.
    static func dockFollowsWindows() {
        let anyVisible = windows.values.contains { $0.window?.isVisible == true }
        let wanted: NSApplication.ActivationPolicy = anyVisible ? .regular : .accessory
        if NSApp.activationPolicy() != wanted { NSApp.setActivationPolicy(wanted) }
    }

    private let item: NSStatusItem
    private var spinner: NSProgressIndicator?
    /// ExactMac's first window: the session's home, kept off screen.
    private(set) weak var hostWindow: NSWindow?
    /// The view the popover shows — ExactMac's, adopted once.
    private weak var hostView: NSView?
    private let popover = NSPopover()
    private let controller = NSViewController()
    private let icon: NSImage
    private var count = 0
    private var busy = false
    private static let size = NSSize(width: 380, height: 600)

    /// What `SecondaryWindow.adopt` must skip: the host window, which is never a secondary.
    var popoverWindow: NSWindow? { hostWindow }

    override init() {
        icon = MenuBar.pullRequestIcon()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        NSApp.setActivationPolicy(.accessory)
        MenuBar.keepRunningWithoutWindows()
        controller.view = NSView(frame: NSRect(origin: .zero, size: MenuBar.size))
        popover.contentViewController = controller
        popover.contentSize = MenuBar.size
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        if let button = item.button {
            button.image = icon
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(clicked(_:))
            // On mouse-down: a transient popover shown on the mouse-up would be
            // closed by that same up event counting as a click outside it.
            button.sendAction(on: [.leftMouseDown, .rightMouseUp])
            button.toolTip = "revu — review requests"
        }
        // The host's window exists by now (the module loads after first pixel);
        // adopt its view once the current turn of the run loop is done with it,
        // and open the popover as the app's first screen.
        DispatchQueue.main.async { [weak self] in
            self?.adoptHostView()
            self?.show(attempt: 0)
        }
    }

    /// ExactMac's delegate quits when its last window closes, and AppKit
    /// runs that check when the last visible window is *hidden* too. An
    /// accessory app lives in the bar; it quits from the item's menu or ⌘Q.
    /// So the delegate's answer becomes "no".
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
        // A reopen (the Dock, Finder, `open -a revu`) shows the popover, as a
        // click on the item does; AppKit's own answer would look for a window.
        let reopen = #selector(NSApplicationDelegate.applicationShouldHandleReopen(_:hasVisibleWindows:))
        let showPopover: @convention(block) (AnyObject, NSApplication, Bool) -> Bool = { _, _, _ in
            DispatchQueue.main.async { MenuBar.shared?.show() }
            return false
        }
        let reopenImp = imp_implementationWithBlock(showPopover)
        if let method = class_getInstanceMethod(cls, reopen) {
            method_setImplementation(method, reopenImp)
        } else {
            class_addMethod(cls, reopen, reopenImp, "B@:@B")
        }
    }

    /// Takes the host window's content view into the popover's controller.
    /// The window stays (ordered out, not closable by the user); its
    /// autosaved frame is switched off so it never comes back on its own.
    private func adoptHostView() {
        guard hostView == nil else { return }
        guard let window = NSApp.windows.first(where: { $0.contentView != nil && !($0 is NSPanel) }) else { return }
        guard let view = window.contentView else { return }
        hostWindow = window
        window.setFrameAutosaveName("")
        window.orderOut(nil)
        window.styleMask.remove(.closable)
        window.collectionBehavior = [.ignoresCycle, .transient]
        view.removeFromSuperview()
        view.frame = controller.view.bounds
        view.autoresizingMask = [.width, .height]
        // Nothing opaque between the popover's vibrancy and the page: the
        // page itself paints no background (PopoverSurface in the contract).
        controller.view.wantsLayer = true
        controller.view.layer?.backgroundColor = NSColor.clear.cgColor
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        view.layer?.isOpaque = false
        controller.view.addSubview(view)
        hostView = view
        // The presenter's own scroll view paints a solid page under the nodes
        // (PresenterMac: drawsBackground, white); it must not, or the vibrancy
        // never shows. Found by type, since the view's internals are the host's.
        MenuBar.clearPageBackground(in: view)
    }

    /// Every scroll view and clip view under `root` stops painting a background.
    private static func clearPageBackground(in root: NSView) {
        var stack: [NSView] = [root]
        while let v = stack.popLast() {
            if let scroll = v as? NSScrollView {
                scroll.drawsBackground = false
                scroll.backgroundColor = .clear
                scroll.contentView.drawsBackground = false
                scroll.contentView.backgroundColor = .clear
            }
            stack.append(contentsOf: v.subviews)
        }
    }

    /// When the popover last closed (process clock): a transient popover
    /// closes on the mouse-down of the very click on the item whose mouse-up
    /// then reaches `clicked`; that click must not reopen it.
    private var closedAt: TimeInterval = 0

    func show(attempt: Int = 0) {
        adoptHostView()
        guard hostView != nil, let button = item.button else { return }
        // The bar may not have placed the item yet (its window is at the origin
        // until then); try again shortly rather than anchoring to nowhere.
        if (button.window?.frame.minY ?? 0) < (NSScreen.main?.frame.maxY ?? 0) - 60, attempt < 60 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.show(attempt: attempt + 1) }
            return
        }
        if popover.isShown { return }
        // Active first: a transient popover shown by an inactive app can be
        // ordered out again at once by AppKit's activation handling.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKeyAndOrderFront(nil)
        hostView?.needsDisplay = true
        button.highlight(true)
    }

    func hide() {
        if popover.isShown { popover.close() }
    }

    func popoverDidClose(_ notification: Notification) {
        closedAt = ProcessInfo.processInfo.systemUptime
        item.button?.highlight(false)
    }

    /// The item's left click toggles. If the popover closed within the last
    /// quarter second, this click is the one that closed it: leave it closed.
    private func toggle() {
        if popover.isShown { hide(); return }
        // A transient popover closes on the mouse-down that reaches this
        // handler when the user clicks the item to dismiss it; that same
        // click must not reopen it.
        if ProcessInfo.processInfo.systemUptime - closedAt < 0.25 { return }
        show()
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
        toggle()
    }

    @objc private func openFromMenu() { show() }
    @objc private func settingsFromMenu() { _ = openWindow(kind: "settings", arg: "") }

    /// A window of a kind (design 1f: settings at 880 × 640): shown again if
    /// it is open, else the host opens a New Window — a second session of the
    /// plan — and that session's module instance takes the kind as its role.
    func openWindow(kind: String, arg: String = "") -> Bool {
        let key = arg.isEmpty ? kind : "\(kind):\(arg)"
        if let existing = MenuBar.windows[key] {
            existing.show()
            return true
        }
        MenuBar.pendingRole = kind
        MenuBar.pendingArg = arg
        let opened = NSApp.sendAction(#selector(NSResponder.newWindowForTab(_:)), to: nil, from: nil)
        if !opened { MenuBar.pendingRole = nil; MenuBar.pendingArg = nil }
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

    /// Lucide's `git-pull-request` as the menu bar glyph: 15 pt, stroke 2,
    /// as the design's menu bar row (3a) draws it; a template image so the
    /// bar tints it for light and dark.
    private static func pullRequestIcon() -> NSImage {
        let size = NSSize(width: 15, height: 15)
        let image = NSImage(size: size, flipped: true) { _ in
            NSColor.black.setStroke()
            let scale = 15.0 / 24.0
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

/// Remote notifications (LLP 0009): a build signed with the `aps-environment`
/// entitlement registers with APNs; the token reaches the app as a device
/// change on the `push` topic (the `pushToken` call reads it) and the app
/// hands it to the sidecar, which registers it with the relay. An ad-hoc
/// build has no entitlement and skips all of this. The device token
/// callbacks are the application delegate's, which is ExactMac's; the two
/// selectors are added to its class at load.
enum RemotePush {
    /// Whether this build carries `aps-environment`. The task API answers
    /// for the kernel's view; the code-signing information reads the signed
    /// entitlement blob itself. Either saying yes is enough to ask APNs; the
    /// OS still decides at registration.
    static var entitled: Bool {
        let key = "com.apple.developer.aps-environment"
        if let task = SecTaskCreateFromSelf(nil), SecTaskCopyValueForEntitlement(task, key as CFString, nil) != nil { return true }
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any],
              let ents = dict[kSecCodeInfoEntitlementsDict as String] as? [String: Any] else { return false }
        return ents[key] != nil
    }

    static func registerIfEntitled() {
        guard entitled, let delegate = NSApp.delegate else { return }
        let cls: AnyClass = type(of: delegate)
        let got: @convention(block) (AnyObject, NSApplication, Data) -> Void = { _, _, data in
            Notifier.pushToken = data.map { String(format: "%02x", $0) }.joined()
            Notifier.pushTokenOwner?.context.changed("push")
        }
        let failed: @convention(block) (AnyObject, NSApplication, Error) -> Void = { _, _, error in
            NSLog("revu: APNs registration failed: %@", error.localizedDescription)
        }
        class_addMethod(cls, #selector(NSApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)), imp_implementationWithBlock(got), "v@:@@")
        class_addMethod(cls, #selector(NSApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:)), imp_implementationWithBlock(failed), "v@:@@")
        // A push that arrives while the app runs: re-poll at once (the OS shows the alert itself).
        let received: @convention(block) (AnyObject, NSApplication, [String: Any]) -> Void = { _, _, _ in
            Notifier.pushTokenOwner?.context.changed("pushed")
        }
        class_addMethod(cls, #selector(NSApplicationDelegate.application(_:didReceiveRemoteNotification:)), imp_implementationWithBlock(received), "v@:@@")
        NSApp.registerForRemoteNotifications()
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
    let arg: String
    var key: String { arg.isEmpty ? kind : "\(kind):\(arg)" }
    private(set) weak var window: NSWindow?

    init(kind: String, arg: String = "") {
        self.kind = kind
        self.arg = arg
        super.init()
        MenuBar.windows[key] = self
        DispatchQueue.main.async { [weak self] in self?.adopt() }
    }

    private func adopt() {
        guard window == nil else { return }
        let taken = Set(MenuBar.windows.values.compactMap { $0.window }.map { ObjectIdentifier($0) })
        let host = MenuBar.shared?.popoverWindow
        guard let w = NSApp.windows.last(where: { $0.contentView != nil && !($0 is NSPanel) && $0 !== host && !taken.contains(ObjectIdentifier($0)) }) else { return }
        window = w
        w.setFrameAutosaveName("")
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.title = kind == "review" ? "revu — Review" : "revu — \(kind.capitalized)"
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
        NotificationCenter.default.addObserver(self, selector: #selector(becameKey(_:)), name: NSWindow.didBecomeKeyNotification, object: w)
        show()
    }

    /// A window in front means the popover goes away: it is a transient
    /// surface, and the two of them at once read as clutter (Gabriel,
    /// 2026-10-01). Focus moving between the app's own windows does not
    /// deactivate the app, so `hidesOnDeactivate` alone never fires here.
    func show() {
        guard let w = window else { return }
        MenuBar.shared?.hide()
        MenuBar.dockFollowsWindows()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func hide() {
        window?.orderOut(nil)
        MenuBar.dockFollowsWindows()
    }

    @objc private func becameKey(_ note: Notification) { MenuBar.shared?.hide() }

    @objc private func closed(_ note: Notification) {
        if MenuBar.windows[key] === self { MenuBar.windows.removeValue(forKey: key) }
        DispatchQueue.main.async { MenuBar.dockFollowsWindows() }
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
