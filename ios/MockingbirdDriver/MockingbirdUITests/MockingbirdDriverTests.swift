import XCTest
import AVFoundation
import Network

/// Mockingbird's hands and eyes on the phone.
///
/// One long-running UI test (`testServe`) polls the Mac's control server for
/// commands and executes them against any installed app by bundle identifier,
/// so it needs no change to the app's own Xcode project and no test hooks in the
/// app. In web-view apps (WKWebView), web controls reach XCUITest through their
/// accessible names (aria-label or text), which is what every command matches.
///
/// Configuration comes from the test runner environment. `xcodebuild` forwards
/// any `TEST_RUNNER_<NAME>` variable to the runner as `<NAME>`:
///   MOCKINGBIRD_CONTROL_URL  poll mode: e.g. http://127.0.0.1:8799 (Simulator) or http://<mac-ip>:8799 (device)
///   MOCKINGBIRD_SERVER_PORT  server mode: listen on this port on the device instead of polling; the Mac
///                            reaches it over USB with `iproxy` (usbmux), so no Local Network permission is
///                            needed (iOS silently denies it to a backgrounded UI-test runner)
///   MOCKINGBIRD_BUNDLE_ID    the app under test (required)
///   MOCKINGBIRD_SESSION_SECONDS  how long to serve before exiting (default 1800)
final class MockingbirdDriverTests: XCTestCase {
    private var app: XCUIApplication!
    private var control: URL!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// XCUITest reports a vanished or unhittable element as a test failure,
    /// which would end the whole serve loop. Every issue becomes the current
    /// command's error instead; the session keeps serving.
    private var pendingIssue: String?
    override func record(_ issue: XCTIssue) {
        pendingIssue = issue.compactDescription
    }

    override func setUpWithError() throws {
        continueAfterFailure = true
        Quiescence.disable()
        let env = ProcessInfo.processInfo.environment
        guard let bundleId = env["MOCKINGBIRD_BUNDLE_ID"], env["MOCKINGBIRD_CONTROL_URL"] != nil || env["MOCKINGBIRD_SERVER_PORT"] != nil else {
            throw XCTSkip("MOCKINGBIRD_BUNDLE_ID and MOCKINGBIRD_CONTROL_URL or MOCKINGBIRD_SERVER_PORT not set; run through Mockingbird")
        }
        control = URL(string: env["MOCKINGBIRD_CONTROL_URL"] ?? "http://127.0.0.1:1")!
        app = XCUIApplication(bundleIdentifier: bundleId)
    }

    /// What this build can do beyond the original commands; the Mac refuses a command a build cannot honour.
    static let capabilities = ["launchEnv"]

    func testServe() throws {
        let seconds = Double(ProcessInfo.processInfo.environment["MOCKINGBIRD_SESSION_SECONDS"] ?? "") ?? 1800
        let deadline = Date().addingTimeInterval(seconds)
        if let port = UInt16(ProcessInfo.processInfo.environment["MOCKINGBIRD_SERVER_PORT"] ?? "") {
            try serve(port: port, until: deadline)
            return
        }
        post("hello", ["driver": "xcuitest", "device": UIDevice.current.name, "system": UIDevice.current.systemVersion, "capabilities": Self.capabilities])
        while Date() < deadline {
            guard let command = fetchCommand() else { continue }
            let id = command["id"] as? String ?? "?"
            let action = command["action"] as? String ?? ""
            let args = command["args"] as? [String: Any] ?? [:]
            if action == "quit" { post("result", ["id": id, "ok": true]); return }
            let started = Date()
            var result: [String: Any] = ["id": id, "action": action]
            pendingIssue = nil
            do {
                let value = try perform(action, args)
                if let issue = pendingIssue { throw RigError(description: issue) }
                result["ok"] = true
                if let value { result["value"] = value }
            } catch {
                result["ok"] = false
                result["error"] = "\(error)"
            }
            result["ms"] = Int(Date().timeIntervalSince(started) * 1000)
            post("result", result)
        }
    }

    // MARK: server mode (usbmux)

    private struct Pending { let command: [String: Any]; let reply: ([String: Any]) -> Void }
    private let pendingLock = NSLock()
    private var pending: [Pending] = []
    private let pendingSignal = DispatchSemaphore(value: 0)

    /// Listens on `port`; each HTTP POST carries one command and gets its
    /// result in the response. Commands run on the test's own thread, one at
    /// a time, exactly as in poll mode.
    private func serve(port: UInt16, until deadline: Date) throws {
        let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: DispatchQueue(label: "mockingbird.server"))
        defer { listener.cancel() }
        while Date() < deadline {
            guard pendingSignal.wait(timeout: .now() + 1) == .success else { continue }
            pendingLock.lock(); let next = pending.removeFirst(); pendingLock.unlock()
            let id = next.command["id"] as? String ?? "?"
            let action = next.command["action"] as? String ?? ""
            let args = next.command["args"] as? [String: Any] ?? [:]
            if action == "hello" {
                next.reply(["id": id, "ok": true, "value": ["driver": "xcuitest", "device": UIDevice.current.name, "system": UIDevice.current.systemVersion, "mode": "server", "capabilities": Self.capabilities]])
                continue
            }
            if action == "quit" { next.reply(["id": id, "ok": true]); return }
            next.reply(execute(id: id, action: action, args: args))
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: DispatchQueue(label: "mockingbird.connection"))
        var buffer = Data()
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
                guard let self else { return }
                if let data { buffer.append(data) }
                if let request = Self.parseRequest(buffer) {
                    let command = (try? JSONSerialization.jsonObject(with: request) as? [String: Any]) ?? [:]
                    let reply: ([String: Any]) -> Void = { result in
                        let body = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
                        var response = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                        response.append(body)
                        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
                    }
                    self.pendingLock.lock(); self.pending.append(Pending(command: command, reply: reply)); self.pendingLock.unlock()
                    self.pendingSignal.signal()
                } else if done || error != nil {
                    connection.cancel()
                } else {
                    readMore()
                }
            }
        }
        readMore()
    }

    /// The body of a complete HTTP request in `data`, or nil if more is needed.
    private static func parseRequest(_ data: Data) -> Data? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let header = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self).lowercased()
        let length = header.split(separator: "\r\n").first { $0.hasPrefix("content-length:") }
            .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= length else { return nil }
        return data.subdata(in: bodyStart..<(bodyStart + length))
    }

    private func execute(id: String, action: String, args: [String: Any]) -> [String: Any] {
        let started = Date()
        var result: [String: Any] = ["id": id, "action": action]
        pendingIssue = nil
        do {
            let value = try perform(action, args)
            if let issue = pendingIssue { throw RigError(description: issue) }
            result["ok"] = true
            if let value { result["value"] = value }
        } catch {
            result["ok"] = false
            result["error"] = "\(error)"
        }
        result["ms"] = Int(Date().timeIntervalSince(started) * 1000)
        return result
    }

    // MARK: commands

    struct RigError: Error, CustomStringConvertible { let description: String }

    private func perform(_ action: String, _ args: [String: Any]) throws -> Any? {
        let timeout = (args["timeout"] as? Double) ?? 10
        // Every UI command works on a foreground app: a test that ended (or a
        // crash) leaves it terminated, and SpringBoard prompts leave it behind.
        let needsApp = !["launch", "terminate", "pressHome", "acceptPermissionAlerts", "allowSystemAlerts", "sleep", "screenshot", "micLevel", "audioRoute"].contains(action)
        if needsApp && app.state != .runningForeground {
            app.activate()
            _ = app.wait(for: .runningForeground, timeout: 15)
        }
        switch action {
        case "launch":
            if args["terminate"] as? Bool == true { app.terminate() }
            // Launch environment (e.g. a debug build's backend switch). Applies
            // only to this launch; activate never carries it.
            if let env = args["env"] as? [String: String] { app.launchEnvironment = env }
            app.launch()
            return app.wait(for: .runningForeground, timeout: timeout)
        case "activate":
            app.activate()
            return app.wait(for: .runningForeground, timeout: timeout)
        case "terminate":
            app.terminate(); return true
        case "tap":
            let element = try find(args, timeout: timeout)
            try scrollIntoView(element)
            let info = describe(element)
            tapCenter(element.frame)
            return info
        case "tapAt":
            // By point (screen coordinates in points), for controls the
            // accessibility tree does not expose (e.g. hidden behind a modal).
            guard let x = args["x"] as? Double, let y = args["y"] as? Double else { throw RigError(description: "tapAt needs x and y") }
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
            return true
        case "tapIfPresent":
            guard let element = try? find(args, timeout: timeout) else { return false }
            tapCenter(element.frame); return true
        case "typeText":
            // Web inputs surface as text fields, or search fields for type="search".
            var element: XCUIElement
            if args["type"] != nil {
                element = try find(args, timeout: timeout)
            } else {
                var fieldArgs = args; fieldArgs["type"] = "field"
                var searchArgs = args; searchArgs["type"] = "search"
                if let field = try? find(fieldArgs, timeout: 1) { element = field }
                else { element = try find(searchArgs, timeout: timeout) }
            }
            tapCenter(element.frame)
            Thread.sleep(forTimeInterval: 0.4)
            if args["clear"] as? Bool == true {
                // Fields keep earlier text across launches; typing would append to it.
                let current = (element.value as? String) ?? ""
                let placeholder = element.placeholderValue ?? ""
                if !current.isEmpty && current != placeholder {
                    // Put the cursor at the end (a centre tap can land mid-text), then delete it all.
                    let frame = element.frame
                    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.maxX - 6, dy: frame.midY)).tap()
                    Thread.sleep(forTimeInterval: 0.2)
                    app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 4))
                }
            }
            app.typeText(args["text"] as? String ?? "")
            if args["submit"] as? Bool == true { app.typeText("\n") }
            return true
        case "waitFor":
            return describe(try find(args, timeout: timeout))
        case "waitForGone":
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if (try? find(args, timeout: 0.5)) == nil { return true }
            }
            throw RigError(description: "still present: \(args)")
        case "slide":
            // A slider gesture: a real press-and-drag across the element, to
            // the far end like a thumb would.
            let element = try find(args, timeout: timeout)
            let info = describe(element)
            let frame = element.frame
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let from = origin.withOffset(CGVector(dx: frame.minX + frame.width * 0.12, dy: frame.midY))
            let to = origin.withOffset(CGVector(dx: frame.minX + frame.width * 0.97, dy: frame.midY))
            from.press(forDuration: 0.15, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
            return info
        case "swipeUp":
            app.swipeUp(); return true
        case "swipeDown":
            app.swipeDown(); return true
        case "acceptPermissionAlerts", "allowSystemAlerts":
            // Never fall back to arbitrary SpringBoard buttons (passcode,
            // trust, local network and other dialogs require a human).
            var handled: [String] = []
            let deadline = Date().addingTimeInterval(min(max(timeout, 0), 5))
            repeat {
                if springboard.secureTextFields.count > 0 || springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "passcode")).count > 0 {
                    print("permission: blocked passcode sheet; no button tapped")
                    throw RigError(description: "permission: blocked passcode sheet; no button tapped; unlock the phone manually")
                }
                for owner in [springboard, app!] {
                    let alert = owner.alerts.firstMatch
                    guard alert.exists else { continue }
                    let title = alert.label.replacingOccurrences(of: "’", with: "'")
                        .replacingOccurrences(of: "“", with: "\"")
                        .replacingOccurrences(of: "”", with: "\"").lowercased()
                    let buttons = alert.buttons.allElementsBoundByIndex.map { $0.label.replacingOccurrences(of: "’", with: "'") }
                    // Setup reminder only: decline setup, never accept it.
                    if title == "finish setting up iphone", buttons.count == 2,
                       Set(buttons) == Set(["Not Now", "OK"]), alert.secureTextFields.count == 0 {
                        alert.buttons["Not Now"].tap()
                        if let issue = pendingIssue { throw RigError(description: issue) }
                        guard alert.waitForNonExistence(timeout: 1) else {
                            throw RigError(description: "permission: setup-nag alert remained after Not Now")
                        }
                        print("permission: setup-nag dismissed")
                        handled.append("setup-nag")
                        continue
                    }
                    let kind: String?
                    let appName = (args["appDisplayName"] as? String)?.lowercased()
                    let prompt = title.hasSuffix(".") ? String(title.dropLast()) : title
                    if let appName, prompt == "\"\(appName)\" would like to access the microphone" {
                        kind = "microphone"
                    } else if let appName, prompt == "\"\(appName)\" would like to send you notifications" {
                        kind = "notifications"
                    } else { kind = nil }
                    guard let kind, buttons.count == 2, Set(buttons) == Set(["Don't Allow", "Allow"]),
                          alert.secureTextFields.count == 0 else {
                        // Do not log dialog contents: a system sheet may contain private data.
                        print("permission: blocked unknown system alert; no button tapped")
                        throw RigError(description: "permission: blocked unknown system alert (or passcode sheet); no button tapped; inspect the phone")
                    }
                    alert.buttons["Allow"].tap()
                    if let issue = pendingIssue { throw RigError(description: issue) }
                    guard alert.waitForNonExistence(timeout: 1) else {
                        throw RigError(description: "permission: \(kind) alert remained after Allow")
                    }
                    print("permission: \(kind) allowed")
                    handled.append(kind)
                }
                if Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
            } while Date() < deadline
            return handled
        case "texts":
            // One snapshot of the whole tree: every label on screen, in order.
            return try snapshotTexts()
        case "screenshot":
            let png = XCUIScreen.main.screenshot().pngRepresentation
            return png.base64EncodedString()
        case "pressButton":
            // Hardware buttons. Volume buttons exist only on physical devices.
            switch args["button"] as? String ?? "" {
            case "home": XCUIDevice.shared.press(.home)
            #if !targetEnvironment(simulator)
            case "volumeUp": XCUIDevice.shared.press(.volumeUp)
            case "volumeDown": XCUIDevice.shared.press(.volumeDown)
            #endif
            default: throw RigError(description: "unsupported button \(args["button"] ?? "") (volume buttons are device-only)")
            }
            Thread.sleep(forTimeInterval: 0.25)
            return AVAudioSession.sharedInstance().outputVolume
        case "audioRoute":
            // Where the device would play audio right now (speaker, receiver,
            // headphones, AirPods...), what inputs exist, and the media volume.
            // Read without activating a session, so it changes nothing.
            let session = AVAudioSession.sharedInstance()
            let route = session.currentRoute
            let port = { (p: AVAudioSessionPortDescription) -> [String: Any] in ["type": p.portType.rawValue, "name": p.portName] }
            return [
                "outputs": route.outputs.map(port),
                "inputs": route.inputs.map(port),
                "availableInputs": (session.availableInputs ?? []).map(port),
                "outputVolume": session.outputVolume,
                "category": session.category.rawValue,
            ]
        case "micLevel":
            // The device's own microphone, measured natively inside the runner
            // (an iOS app on the same device): separates "the device hears
            // nothing" from "the app under test's capture path hears nothing".
            return try measureMicLevel(seconds: (args["seconds"] as? Double) ?? 5)
        case "sleep":
            Thread.sleep(forTimeInterval: (args["seconds"] as? Double) ?? 1); return true
        case "pressHome":
            XCUIDevice.shared.press(.home); return true
        default:
            throw RigError(description: "unknown action \(action)")
        }
    }

    /// Finds an element by accessible name. `label` is exact, `prefix` matches
    /// the start, `contains` is a case-insensitive substring; `type` narrows to button/text/field/any.
    /// Finds an element by accessible name. `label` is exact, `prefix` matches
    /// the start, `contains` is a case-insensitive substring; `type` narrows to button / control / text /
    /// field / search / link / any. `control` is anything tappable: web
    /// buttons with aria-pressed surface as switches.
    private func find(_ args: [String: Any], timeout: Double) throws -> XCUIElement {
        var typePredicate: NSPredicate?
        var type: XCUIElement.ElementType = .any
        switch args["type"] as? String ?? "any" {
        case "button": type = .button
        case "control":
            typePredicate = NSPredicate(format: "elementType IN %@", [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.switch.rawValue, XCUIElement.ElementType.toggle.rawValue])
        case "switch": type = .switch
        case "text": type = .staticText
        case "field": type = .textField
        case "search": type = .searchField
        case "link": type = .link
        default: type = .any
        }
        var predicate: NSPredicate
        if let label = args["label"] as? String {
            predicate = NSPredicate(format: "label == %@", label)
        } else if let prefix = args["prefix"] as? String {
            predicate = NSPredicate(format: "label BEGINSWITH[c] %@", prefix)
        } else if let contains = args["contains"] as? String {
            predicate = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR placeholderValue CONTAINS[c] %@", contains, contains, contains)
        } else {
            throw RigError(description: "find needs label, prefix or contains")
        }
        if let typePredicate { predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [typePredicate, predicate]) }
        let query = app.descendants(matching: type).matching(predicate)
        let index = args["index"] as? Int ?? 0
        let element = query.element(boundBy: index)
        if element.waitForExistence(timeout: max(timeout, 0.1)) { return element }
        throw RigError(description: "not found: \(args)")
    }

    /// Web content far down a list exists in the tree but is off screen; a
    /// coordinate tap there lands on something else. Swipe until it is visible.
    private func scrollIntoView(_ element: XCUIElement) throws {
        let screen = app.windows.firstMatch.frame
        let visible = CGRect(x: 0, y: 50, width: screen.width, height: screen.height - 50)
        var last = CGRect.null
        for _ in 0..<25 {
            let frame = element.frame
            if frame.isEmpty || visible.contains(CGPoint(x: frame.midX, y: frame.midY)) { return }
            if frame == last { return } // fixed-position chrome: a swipe does not move it
            last = frame
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: screen.midX, dy: screen.midY))
            let delta = min(screen.height * 0.35, abs(frame.midY - screen.midY))
            let end = start.withOffset(CGVector(dx: 0, dy: frame.midY > screen.midY ? -delta : delta))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.25)
        }
        throw RigError(description: "could not scroll \(element.label) into view")
    }

    private func tapCenter(_ frame: CGRect) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
    }

    private func describe(_ element: XCUIElement) -> [String: Any] {
        ["label": element.label, "frame": NSCoder.string(for: element.frame)]
    }

    private func measureMicLevel(seconds: Double) throws -> [[String: Any]] {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
        try session.setActive(true)
        defer { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RigError(description: "no microphone input format (\(format))") }
        let lock = NSLock()
        var levels: [[String: Any]] = []
        let started = Date()
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            var sum: Float = 0
            for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(max(1, buffer.frameLength)))
            let db = rms > 0 ? 20 * log10(rms) : -120
            lock.lock(); levels.append(["t": Int(Date().timeIntervalSince(started) * 1000), "db": Int(db.rounded())]); lock.unlock()
        }
        engine.prepare()
        try engine.start()
        Thread.sleep(forTimeInterval: seconds)
        input.removeTap(onBus: 0)
        engine.stop()
        lock.lock(); defer { lock.unlock() }
        return levels
    }

    private func snapshotTexts() throws -> [[String: Any]] {
        let root = try app.snapshot()
        var out: [[String: Any]] = []
        func walk(_ node: XCUIElementSnapshot) {
            let label = node.label
            let value = (node.value as? String) ?? ""
            if !label.isEmpty || !value.isEmpty {
                var row: [String: Any] = ["type": Self.typeName(node.elementType), "label": label]
                if !value.isEmpty { row["value"] = value }
                if !node.identifier.isEmpty { row["id"] = node.identifier }
                row["y"] = Int(node.frame.minY)
                out.append(row)
            }
            for child in node.children { walk(child) }
        }
        walk(root)
        return out
    }

    private static func typeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .button: return "button"
        case .staticText: return "text"
        case .textField: return "field"
        case .searchField: return "search"
        case .link: return "link"
        case .image: return "image"
        case .switch: return "switch"
        case .toggle: return "toggle"
        case .other: return "other"
        default: return "\(type.rawValue)"
        }
    }

    // MARK: transport (plain HTTP long-poll to the Mac)

    private func fetchCommand() -> [String: Any]? {
        var request = URLRequest(url: control.appendingPathComponent("next"))
        request.timeoutInterval = 30
        guard let data = send(request), !data.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["action"] != nil else { return nil }
        return json
    }

    private func post(_ path: String, _ body: [String: Any]) {
        var request = URLRequest(url: control.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 30
        _ = send(request)
    }

    private func send(_ request: URLRequest) -> Data? {
        let done = DispatchSemaphore(value: 0)
        var result: Data?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 { result = data }
            done.signal()
        }.resume()
        if done.wait(timeout: .now() + request.timeoutInterval + 5) == .timedOut { return nil }
        if result == nil { Thread.sleep(forTimeInterval: 0.5) }
        return result
    }
}


/// Continuously animated screens, so
/// XCUITest's "wait for the app to idle" before and after each event can
/// stall for a long time. Mockingbird waits for what it needs explicitly instead.
/// Same approach as WebDriverAgent's waitForQuiescence=false. Private API,
/// test bundle only, never shipped in an app.
enum Quiescence {
    static func disable() {
        guard let cls = NSClassFromString("XCUIApplicationProcess") else { return }
        let noOp1: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
        let noOp2: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:")) {
            method_setImplementation(m, imp_implementationWithBlock(noOp1))
        }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")) {
            method_setImplementation(m, imp_implementationWithBlock(noOp2))
        }
    }
}
