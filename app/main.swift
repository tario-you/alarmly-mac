// Wake: a Mac alarm that takes over every screen, plays a loud alarm at full
// volume, and only stops once you solve math problems. Menu bar app.
import AppKit
import AVFoundation
import IOKit.pwr_mgt
import ServiceManagement
import SwiftUI

// MARK: - Model

struct Alarm: Codable, Identifiable, Equatable {
    var id = UUID()
    var hour = 7
    var minute = 0
    var days: Set<Int> = []   // Calendar weekday 1=Sun ... 7=Sat; empty = once
    var enabled = true
    var problems = 3
    var label = ""

    var timeText: String { String(format: "%d:%02d", hour, minute) }

    var daysText: String {
        if days.isEmpty { return "Once" }
        if days.count == 7 { return "Every day" }
        if days == [2, 3, 4, 5, 6] { return "Weekdays" }
        if days == [1, 7] { return "Weekends" }
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return days.sorted().map { names[$0 - 1] }.joined(separator: " ")
    }

    func nextFire(after d: Date, cal: Calendar = .current) -> Date? {
        let start = cal.startOfDay(for: d)
        for offset in 0...7 {
            guard let day = cal.date(byAdding: .day, value: offset, to: start),
                  let c = cal.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { continue }
            if c > d && (days.isEmpty || days.contains(cal.component(.weekday, from: c))) { return c }
        }
        return nil
    }
}

struct Problem {
    let a: Int, b: Int, c: Int
    var text: String { "\(a) × \(b) + \(c)" }
    var answer: Int { a * b + c }
    static func random() -> Problem {
        Problem(a: Int.random(in: 13...49), b: Int.random(in: 3...9), c: Int.random(in: 101...399))
    }
}

/// The trigger URL: `wake://ring?label=Text&problems=2` rings now. Anything that can open a URL can ring Wake
/// (`open -g "wake://ring?label=Hi"`, Shortcuts, a script, a launchd job). 
enum RingURL {
    static func alarm(from url: URL) -> Alarm? {
        guard url.scheme?.lowercased() == "wake", url.host?.lowercased() == "ring" else { return nil }
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func v(_ k: String) -> String? { q.first { $0.name == k }?.value }
        let n = Swift.min(10, Swift.max(1, Int(v("problems") ?? "") ?? 2))
        return Alarm(problems: n, label: String((v("label") ?? "").prefix(80)))
    }
}

final class AlarmStore: ObservableObject {
    static let shared = AlarmStore()
    private let key: String
    @Published var alarms: [Alarm] = [] { didSet { save() } }

    init(key: String = "alarms.v1") {
        self.key = key
        if let data = UserDefaults.standard.data(forKey: key),
           let a = try? JSONDecoder().decode([Alarm].self, from: data) { _alarms = Published(initialValue: a) }
    }
    static var persist = true          // off in test hooks so real alarms are untouched
    private func save() {
        guard AlarmStore.persist else { return }
        if let data = try? JSONEncoder().encode(alarms) { UserDefaults.standard.set(data, forKey: key) }
        Scheduler.shared.reschedule()
    }
    func upsert(_ a: Alarm) {
        if let i = alarms.firstIndex(where: { $0.id == a.id }) { alarms[i] = a } else { alarms.append(a) }
        alarms.sort { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
    }
    func delete(_ a: Alarm) { alarms.removeAll { $0.id == a.id } }
}

// MARK: - Scheduler (1 s tick, keeps the Mac from idle-sleeping while armed)

final class Scheduler {
    static let shared = Scheduler()
    private var timer: Timer?
    private var fireAt: [UUID: Date] = [:]
    private var sleepAssertion: IOPMAssertionID = 0
    var onChange: (() -> Void)?

    func start() {
        reschedule()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        timer?.tolerance = 0.2
    }

    func reschedule() {
        let now = Date()
        fireAt = [:]
        for a in AlarmStore.shared.alarms where a.enabled { fireAt[a.id] = a.nextFire(after: now) }
        updateSleepAssertion()
        onChange?()
    }

    var next: (Alarm, Date)? {
        AlarmStore.shared.alarms.compactMap { a in fireAt[a.id].map { (a, $0) } }.min { $0.1 < $1.1 }
    }

    private func tick() {
        let now = Date()
        for a in AlarmStore.shared.alarms where a.enabled {
            guard let f = fireAt[a.id], now >= f else { continue }
            // Mac woke up late: still ring if within 15 minutes.
            if now.timeIntervalSince(f) < 900 { Ringer.shared.ring(a) }
            if a.days.isEmpty {
                var off = a; off.enabled = false; AlarmStore.shared.upsert(off)
            } else {
                fireAt[a.id] = a.nextFire(after: now); onChange?()
            }
        }
    }

    private func updateSleepAssertion() {
        let armed = !fireAt.isEmpty
        if armed && sleepAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                        IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "Wake alarm armed" as CFString, &sleepAssertion)
        } else if !armed && sleepAssertion != 0 {
            IOPMAssertionRelease(sleepAssertion); sleepAssertion = 0
        }
    }
}

// MARK: - Sound and volume

enum Siren {
    // 2 s loop: four harsh beeps alternating 880 / 1320 Hz.
    static func wav() -> Data {
        let rate = 44100, seconds = 2.0
        let n = Int(Double(rate) * seconds)
        var samples = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            let t = Double(i) / Double(rate)
            let slot = Int(t / 0.5), inSlot = t.truncatingRemainder(dividingBy: 0.5)
            guard inSlot < 0.32 else { continue }
            let f = slot % 2 == 0 ? 880.0 : 1320.0
            let sq = sin(2 * .pi * f * t) >= 0 ? 1.0 : -1.0
            let edge = min(1, inSlot / 0.005, (0.32 - inSlot) / 0.005)
            samples[i] = Int16(sq * edge * 0.85 * 32767)
        }
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + n * 2))
        d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(n * 2))
        samples.withUnsafeBytes { d.append(contentsOf: $0) }
        return d
    }
}

enum Volume {
    static func run(_ s: String) -> NSAppleEventDescriptor? {
        var err: NSDictionary?
        return NSAppleScript(source: s)?.executeAndReturnError(&err)
    }
    static func get() -> (Int, Bool) {
        let v = Int(run("output volume of (get volume settings)")?.int32Value ?? 50)
        let m = run("output muted of (get volume settings)")?.booleanValue ?? false
        return (v, m)
    }
    static func max() { _ = run("set volume without output muted\nset volume output volume 100") }
    static func restore(_ s: (Int, Bool)) {
        _ = run("set volume output volume \(s.0)")
        if s.1 { _ = run("set volume with output muted") }
    }
}

// MARK: - Ringer (kiosk takeover)

final class KioskWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class Ringer: ObservableObject {
    static let shared = Ringer()
    static var silent = false          // tests: no sound, no volume change
    static var headless = false        // tests: build kiosk windows but never show them
    /// The siren goes silent while you type an answer, and comes back this long after the last key.
    static var quietFor: TimeInterval = 20
    var windowsForTest: [NSWindow] { windows }
    var playerForTest: AVAudioPlayer? { player }

    @Published var alarm: Alarm?
    @Published var problem = Problem.random()
    @Published var solved = 0
    @Published var feedback = ""
    @Published var lastKey = Date.distantPast
    var total: Int { alarm?.problems ?? 3 }
    var isQuiet: Bool { Date().timeIntervalSince(lastKey) < Ringer.quietFor }
    var quietLeft: Int { Swift.max(0, Int((Ringer.quietFor - Date().timeIntervalSince(lastKey)).rounded(.up))) }
    /// What the siren plays at, before the test mute: 0 while typing, 1 otherwise.
    private(set) var sirenVolume: Float = 1

    private var windows: [NSWindow] = []
    private var player: AVAudioPlayer?
    private var savedVolume: (Int, Bool)?
    private var guardTimer: Timer?
    private var activationObserver: Any?
    private var startedAt = Date()

    var isRinging: Bool { alarm != nil }

    func ring(_ a: Alarm) {
        guard !isRinging else { return }
        alarm = a; solved = 0; feedback = ""; problem = .random(); startedAt = Date(); lastKey = .distantPast
        var id: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("Wake alarm" as CFString, kIOPMUserActiveLocal, &id)
        takeOverScreens(show: !Ringer.headless)
        if !Ringer.silent { savedVolume = Volume.get(); Volume.max() }
        player = try? AVAudioPlayer(data: Siren.wav())
        player?.numberOfLoops = -1
        updateLoudness()
        player?.play()
        guardTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.enforce() }
    }

    static let lockOptions: NSApplication.PresentationOptions =
        [.hideDock, .hideMenuBar, .disableProcessSwitching, .disableForceQuit,
         .disableSessionTermination, .disableHideApplication, .disableAppleMenu]

    private func takeOverScreens(show: Bool) {
        if show {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            NSApp.presentationOptions = Ringer.lockOptions
        }
        let main = NSScreen.main ?? NSScreen.screens[0]
        for screen in NSScreen.screens {
            let w = KioskWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            w.level = .screenSaver
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            w.backgroundColor = .black
            w.contentView = NSHostingView(rootView: screen == main ? AnyView(RingView(r: self)) : AnyView(BlankRing()))
            w.setFrame(screen.frame, display: true)
            windows.append(w)
            guard show else { continue }
            w.orderFrontRegardless()
            if screen == main { w.makeKeyAndOrderFront(nil) }
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.reassert()
        }
    }

    private func reassert() {
        guard isRinging else { return }
        NSApp.activate(ignoringOtherApps: true)
        windows.forEach { $0.orderFrontRegardless() }
        windows.first(where: { $0.contentView is NSHostingView<AnyView> })?.makeKey()
    }

    private func enforce() {
        guard isRinging else { return }
        if !NSApp.isActive { reassert() }
        updateLoudness()
        if !Ringer.silent && !isQuiet { let (v, m) = Volume.get(); if v < 100 || m { Volume.max() } }
        if player?.isPlaying == false { player?.play() }
        if Date().timeIntervalSince(startedAt) > 3600 { stop() }   // hard cap: 1 hour
    }

    /// Each key in the answer box, right or wrong, any key: the siren stops at once and stays off while you keep typing.
    /// Owner's rule: never gate this on a correct answer (a 11-11 change that did was reverted 11-12).
    func typed() {
        guard isRinging else { return }
        lastKey = Date()
        updateLoudness()
    }

    /// Silent within quietFor of the last key, full blast otherwise. Runs on every key and every second.
    func updateLoudness() {
        sirenVolume = isQuiet ? 0 : 1
        player?.volume = Ringer.silent ? 0 : sirenVolume
    }

    func submit(_ text: String) -> Bool {
        let digits = text.trimmingCharacters(in: .whitespaces)
        guard let n = Int(digits) else { feedback = "Numbers only"; return false }
        if n == problem.answer {
            solved += 1; feedback = ""
            if solved >= total { stop(); return true }
        } else {
            feedback = "Wrong. New problem."
        }
        problem = .random()
        return n == problem.answer
    }

    func stop() {
        guard isRinging else { return }
        player?.stop(); player = nil
        if let s = savedVolume { Volume.restore(s); savedVolume = nil }
        guardTimer?.invalidate(); guardTimer = nil
        if let o = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        if !Ringer.headless { NSApp.presentationOptions = [] }
        windows.forEach { $0.orderOut(nil) }
        windows = []
        alarm = nil
        if !Ringer.headless { NSApp.setActivationPolicy(.accessory) }
    }
}

// MARK: - Views

struct BlankRing: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            ZStack {
                Color.black
                Text(ctx.date, format: .dateTime.hour().minute())
                    .font(.system(size: 140, weight: .bold, design: .rounded)).foregroundStyle(.red)
            }
        }
    }
}

struct RingView: View {
    @ObservedObject var r: Ringer
    @State private var input = ""
    @FocusState private var focused: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            ZStack {
                LinearGradient(colors: [Color(red: 0.35, green: 0, blue: 0), .black], startPoint: .top, endPoint: .bottom)
                VStack(spacing: 26) {
                    Text(ctx.date, format: .dateTime.hour().minute())
                        .font(.system(size: 150, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    if let l = r.alarm?.label, !l.isEmpty {
                        Text(l).font(.system(size: 32, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                    }
                    Text("Problem \(r.solved + 1) of \(r.total)")
                        .font(.system(size: 22, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
                    Text("\(r.problem.text) = ?")
                        .font(.system(size: 72, weight: .semibold, design: .monospaced)).foregroundStyle(.white)
                    TextField("", text: $input)
                        .textFieldStyle(.plain)
                        .font(.system(size: 60, weight: .bold, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .frame(width: 360, height: 90)
                        .background(RoundedRectangle(cornerRadius: 18).fill(.white.opacity(0.12)))
                        .focused($focused)
                        .onChange(of: input) { _, _ in r.typed() }
                        .onSubmit { r.typed(); _ = r.submit(input); input = ""; focused = true }
                    Text(r.feedback.isEmpty ? " " : r.feedback)
                        .font(.system(size: 24, weight: .semibold)).foregroundStyle(.red)
                    Text(r.isQuiet ? "Quiet while you type · back in \(r.quietLeft) s" : "Type the answer to quiet it")
                        .font(.system(size: 20, weight: .medium)).foregroundStyle(.white.opacity(0.55))
                    HStack(spacing: 10) {
                        ForEach(0..<r.total, id: \.self) { i in
                            Circle().fill(i < r.solved ? Color.green : Color.white.opacity(0.2)).frame(width: 16, height: 16)
                        }
                    }
                }
            }
        }
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { focused = true } }
    }
}

struct DayPicker: View {
    @Binding var days: Set<Int>
    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(["S", "M", "T", "W", "T", "F", "S"].enumerated()), id: \.offset) { i, n in
                let d = i + 1, on = days.contains(d)
                Button { if on { days.remove(d) } else { days.insert(d) } } label: {
                    Text(n).font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30)
                        .background(Circle().fill(on ? Color.accentColor : Color.secondary.opacity(0.15)))
                        .foregroundStyle(on ? .white : .primary)
                }.buttonStyle(.plain)
            }
        }
    }
}

struct EditorView: View {
    @State var alarm: Alarm
    let isNew: Bool
    let done: () -> Void

    private var time: Binding<Date> {
        Binding(get: { Calendar.current.date(bySettingHour: alarm.hour, minute: alarm.minute, second: 0, of: Date())! },
                set: { let c = Calendar.current.dateComponents([.hour, .minute], from: $0)
                       alarm.hour = c.hour ?? 7; alarm.minute = c.minute ?? 0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(isNew ? "New alarm" : "Edit alarm").font(.title2.bold())
            DatePicker("Time", selection: time, displayedComponents: .hourAndMinute)
            VStack(alignment: .leading, spacing: 6) {
                Text("Repeat").font(.subheadline).foregroundStyle(.secondary)
                DayPicker(days: $alarm.days)
                Text(alarm.daysText).font(.caption).foregroundStyle(.secondary)
            }
            Stepper("Math problems to stop it: \(alarm.problems)", value: $alarm.problems, in: 1...10)
            TextField("Label", text: $alarm.label)
            HStack {
                if !isNew {
                    Button("Delete", role: .destructive) { AlarmStore.shared.delete(alarm); done() }
                }
                Spacer()
                Button("Cancel") { done() }.keyboardShortcut(.cancelAction)
                Button("Save") { alarm.enabled = true; AlarmStore.shared.upsert(alarm); done() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22).frame(width: 340)
    }
}

final class LoginItem: ObservableObject {
    @Published var on = SMAppService.mainApp.status == .enabled
    func set(_ v: Bool) {
        do { if v { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch {}
        on = SMAppService.mainApp.status == .enabled
    }
}

struct ContentView: View {
    @ObservedObject var store = AlarmStore.shared
    @StateObject var login = LoginItem()
    @State private var editing: Alarm?
    @State private var isNew = false
    @State private var tick = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Alarms").font(.title.bold())
                Spacer()
                Button { isNew = true; editing = Alarm() } label: { Image(systemName: "plus") }
                    .keyboardShortcut("n")
            }.padding([.horizontal, .top], 18).padding(.bottom, 8)

            if store.alarms.isEmpty {
                Spacer()
                Text("No alarms").foregroundStyle(.secondary)
                Spacer()
            } else {
                List {
                    ForEach(store.alarms) { a in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(a.timeText).font(.system(size: 34, weight: .light, design: .rounded))
                                Text([a.label, a.daysText, "\(a.problems) problems"].filter { !$0.isEmpty }
                                    .joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(get: { a.enabled },
                                                     set: { var b = a; b.enabled = $0; store.upsert(b) }))
                                .toggleStyle(.switch).labelsHidden()
                        }
                        .opacity(a.enabled ? 1 : 0.5)
                        .contentShape(Rectangle())
                        .onTapGesture { isNew = false; editing = a }
                    }
                }
            }
            Divider()
            HStack {
                Text(nextText).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Toggle("Open at login", isOn: Binding(get: { login.on }, set: { login.set($0) }))
                    .toggleStyle(.checkbox)
                Button("Test") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        Ringer.shared.ring(Alarm(problems: 1, label: "Test alarm"))
                    }
                }.help("Rings in 5 seconds with one problem")
            }.padding(12)
        }
        .frame(minWidth: 380, minHeight: 420)
        .sheet(item: $editing) { a in EditorView(alarm: a, isNew: isNew) { editing = nil } }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { _ in tick += 1 }
    }

    var nextText: String {
        _ = tick
        guard let (_, d) = Scheduler.shared.next else { return "No alarm set" }
        let mins = Int(d.timeIntervalSinceNow / 60)
        return "Rings in \(mins / 60) h \(mins % 60) min"
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    var status: NSStatusItem!
    var window: NSWindow?

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "alarm.fill", accessibilityDescription: "Wake")
        status.button?.imagePosition = .imageLeading
        Scheduler.shared.onChange = { [weak self] in self?.refreshStatus() }
        Scheduler.shared.start()
        if !UserDefaults.standard.bool(forKey: "launched.v1") {
            UserDefaults.standard.set(true, forKey: "launched.v1")
            LoginItem().set(true)
            openWindow()
        }
        refreshStatus()
    }

    func refreshStatus() {
        let next = Scheduler.shared.next
        status.button?.title = next.map { " " + $0.0.timeText } ?? ""
        let m = NSMenu()
        m.addItem(withTitle: next.map { "Next: " + $0.1.formatted(.dateTime.weekday().hour().minute()) } ?? "No alarm set",
                  action: nil, keyEquivalent: "")
        m.addItem(.separator())
        m.addItem(withTitle: "Alarms…", action: #selector(openWindow), keyEquivalent: ",").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "Quit Wake", action: #selector(quit), keyEquivalent: "q").target = self
        status.menu = m
    }

    @objc func openWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 460),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "Wake"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: ContentView())
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls { if let a = RingURL.alarm(from: u) { Ringer.shared.ring(a); break } }
    }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool { openWindow(); return false }

    @objc func quit() {
        guard !Ringer.shared.isRinging else { return }
        if Scheduler.shared.next != nil {
            let a = NSAlert()
            a.messageText = "Quit Wake?"
            a.informativeText = "Your alarms will not ring until Wake is open again."
            a.addButton(withTitle: "Keep Running"); a.addButton(withTitle: "Quit")
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() == .alertFirstButtonReturn { return }
        }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
        Ringer.shared.isRinging ? .terminateCancel : .terminateNow
    }
}

// MARK: - Test hooks

func renderPNG<V: View>(_ v: V, size: NSSize, to path: String) {
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.appearance = NSAppearance(named: .darkAqua)
    let h = NSHostingView(rootView: v.frame(width: size.width, height: size.height)
        .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark))
    h.appearance = NSAppearance(named: .darkAqua)
    w.contentView = h
    h.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    let rep = h.bitmapImageRepForCachingDisplay(in: h.bounds)!
    h.cacheDisplay(in: h.bounds, to: rep)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func selftest() -> Int32 {
    var fails = 0
    func check(_ c: Bool, _ m: String) { print(c ? "ok   " : "FAIL ", m); if !c { fails += 1 } }
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    let fri = cal.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 23, minute: 0))!  // Friday 23:00
    let once = Alarm(hour: 7, minute: 30)
    check(once.nextFire(after: fri, cal: cal) == cal.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 7, minute: 30)),
          "once alarm rings next morning")
    let weekdays = Alarm(hour: 7, minute: 0, days: [2, 3, 4, 5, 6])
    check(weekdays.nextFire(after: fri, cal: cal) == cal.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 7)),
          "weekday alarm skips Sat/Sun to Monday")
    let late = Alarm(hour: 23, minute: 30)
    check(late.nextFire(after: fri, cal: cal) == cal.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 23, minute: 30)),
          "later today rings today")
    check(Siren.wav().count == 44 + 44100 * 2 * 2, "siren wav is 2 s 16-bit mono")
    let u = RingURL.alarm(from: URL(string: "wake://ring?label=WeChat%3A%20Alice&problems=4")!)
    check(u?.label == "WeChat: Alice" && u?.problems == 4 && u?.days.isEmpty == true, "wake://ring URL parses label and problems")
    check(RingURL.alarm(from: URL(string: "wake://ring?problems=99")!)?.problems == 10, "wake://ring clamps problems to 10")
    check(RingURL.alarm(from: URL(string: "wake://ring")!)?.problems == 2, "wake://ring defaults to 2 problems")
    check(RingURL.alarm(from: URL(string: "wake://open")!) == nil && RingURL.alarm(from: URL(string: "https://ring")!) == nil,
          "only wake://ring rings")
    let ps = (0..<200).map { _ in Problem.random() }
    check(ps.allSatisfy { $0.answer == $0.a * $0.b + $0.c && $0.answer > 100 }, "200 problems well formed")

    Ringer.silent = true; Ringer.headless = true; AlarmStore.persist = false
    let saved = Alarm(hour: 8, minute: 0, label: "persisted")
    UserDefaults.standard.set(try! JSONEncoder().encode([saved]), forKey: "alarms.v1.selftest")
    check(AlarmStore(key: "alarms.v1.selftest").alarms == [saved], "loads saved alarms at launch without deadlock")
    UserDefaults.standard.removeObject(forKey: "alarms.v1.selftest")
    let r = Ringer.shared
    r.ring(Alarm(problems: 2, label: "selftest"))
    let volBefore = Volume.get()
    check(r.isRinging, "ring starts")
    check(r.playerForTest?.isPlaying == true && r.playerForTest?.numberOfLoops == -1, "siren playing on loop (muted for test)")
    check(r.sirenVolume == 1 && !r.isQuiet, "siren at full before any key")
    r.typed(); check(r.sirenVolume == 0 && r.isQuiet, "siren silent the moment you type")
    r.lastKey = Date().addingTimeInterval(-(Ringer.quietFor - 2)); r.updateLoudness()
    check(r.sirenVolume == 0, "still silent \(Int(Ringer.quietFor) - 2) s after the last key")
    r.lastKey = Date().addingTimeInterval(-(Ringer.quietFor + 1)); r.updateLoudness()
    check(r.sirenVolume == 1 && !r.isQuiet, "siren back at full \(Int(Ringer.quietFor) + 1) s after the last key")
    check(r.playerForTest?.volume == 0, "test mute holds through quiet and loud")
    // A real key into the math screen's answer box, through AppKit's field editor. SwiftUI orders a window front once its
    // focused field changes, so this runs in its own window, fully transparent and far off every screen, closed after.
    func field(_ v: NSView) -> NSTextField? {
        if let f = v as? NSTextField, f.isEditable { return f }
        return v.subviews.lazy.compactMap(field).first
    }
    let tw = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 1440, height: 900), styleMask: [.borderless],
                      backing: .buffered, defer: false)
    tw.alphaValue = 0; tw.isReleasedWhenClosed = false
    let th = NSHostingView(rootView: RingView(r: r)); tw.contentView = th
    th.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    let tf = field(th)
    check(tf != nil, "answer box found on the math screen")
    if let tf, tw.makeFirstResponder(tf), let ed = tf.currentEditor() as? NSTextView {
        ed.insertText("4", replacementRange: NSRange(location: NSNotFound, length: 0))
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    }
    check(r.isQuiet && r.sirenVolume == 0, "a key typed in the answer box silences the siren")
    tw.orderOut(nil); tw.close()
    r.lastKey = .distantPast; r.updateLoudness()
    check(r.windowsForTest.count == NSScreen.screens.count, "one kiosk window per screen (\(NSScreen.screens.count))")
    check(r.windowsForTest.allSatisfy { w in w.level == .screenSaver && w.canBecomeKey
            && NSScreen.screens.contains { $0.frame == w.frame } }, "kiosk windows at screen-saver level, full screen")
    check(r.windowsForTest.contains { $0.contentView is NSHostingView<AnyView> }, "math screen hosted on main screen")
    check(!r.windowsForTest.contains { $0.isVisible }, "kiosk windows never shown in test")
    check(NSApp.presentationOptions.isDisjoint(with: [.disableProcessSwitching, .disableForceQuit, .hideDock]),
          "screen lock never applied in test")
    check(Ringer.lockOptions.isSuperset(of: [.disableForceQuit, .disableProcessSwitching, .hideDock]), "lock blocks force quit and Cmd-Tab")
    check(NSApp.delegate?.applicationShouldTerminate?(NSApp) == .terminateCancel, "quit blocked while ringing")
    _ = r.submit("abc"); check(r.isRinging && r.solved == 0, "non-number rejected")
    _ = r.submit(String(r.problem.answer + 1)); check(r.isRinging && r.solved == 0, "wrong answer rejected")
    _ = r.submit(String(r.problem.answer)); check(r.isRinging && r.solved == 1, "1 of 2 solved, still ringing")
    _ = r.submit(String(r.problem.answer)); check(!r.isRinging, "2 of 2 solved, alarm stops")
    check(NSApp.delegate?.applicationShouldTerminate?(NSApp) == .terminateNow, "quit allowed after")
    check(r.playerForTest == nil && r.windowsForTest.isEmpty, "siren stopped, windows closed")
    check(Volume.get() == volBefore, "system volume untouched by test (\(volBefore.0))")
    return fails == 0 ? 0 : 1
}

let app = NSApplication.shared
let args = CommandLine.arguments
if args.contains("--selftest") {
    app.setActivationPolicy(.accessory)
    let d = AppDelegate(); app.delegate = d
    exit(selftest())
}
if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
    AlarmStore.persist = false
    let dir = args[i + 1]
    let r = Ringer.shared
    r.alarm = Alarm(problems: 3, label: "WeChat: Alice"); r.solved = 1
    renderPNG(RingView(r: r), size: NSSize(width: 1440, height: 900), to: dir + "/ring.png")
    r.lastKey = Date().addingTimeInterval(-6)
    renderPNG(RingView(r: r), size: NSSize(width: 1440, height: 900), to: dir + "/ring-typing.png")
    AlarmStore.shared.alarms = [Alarm(hour: 7, minute: 0, days: [2, 3, 4, 5, 6], label: "Work"),
                                Alarm(hour: 9, minute: 30, days: [1, 7], enabled: false)]
    renderPNG(ContentView(), size: NSSize(width: 400, height: 460), to: dir + "/alarms.png")
    exit(0)
}
let delegate = AppDelegate()
app.delegate = delegate
app.run()
