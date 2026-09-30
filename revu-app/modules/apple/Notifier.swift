// revu's one native module (exact2 LLP 1067.000): local notifications on
// Apple through `UNUserNotificationCenter`, asked over `native.later`, with
// the user's answer coming back as a device change (`context.changed`,
// LLP 1016.002) that a watching source drains.
//
// The `revu-notifier` view exists because the Apple module artifact is only
// built for an app whose roster names a tag; it draws nothing.
//
// Under the agent (`context.agent`) the OS is never asked: permission is
// granted, a notification is remembered, and `simulate` plays a user's
// answer back through the same change path, so a drive is repeatable and
// never prompts (LLP 1067.000 Q7).
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

    required init(context: ExactModuleContext) {
        super.init(context: context)
        if context.agent { permission = "granted" }
    }

    // MARK: cheap queries (main thread, inside the asking answer's budget)

    override func call(_ request: [String: Any]) throws -> [String: Any] {
        switch request["op"] as? String {
        case "status":
            return ["available": available, "permission": permission, "pending": pendingCount]
        case "drain":
            return ["actions": drain()]
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

    // MARK: the OS

    /// `UNUserNotificationCenter.current()` raises, not throws, for a process
    /// with no bundle identifier; an unbundled host degrades to "unavailable".
    private var available: Bool { context.agent || Bundle.main.bundleIdentifier != nil }

    private var pendingCount: Int {
        lock.lock(); defer { lock.unlock() }
        return pending.count
    }

    private func installDelegate() {
        guard !context.agent, delegate == nil, available else { return }
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
        DispatchQueue.main.async { self.retireCategory(for: notificationId) }
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
