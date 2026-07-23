import AppKit
import Foundation

private enum GatewayState {
  case online
  case connecting
  case offline
  case notLoggedIn

  var title: String {
    switch self {
    case .online: return "Livis Codex 在线"
    case .connecting: return "Livis Codex 连接中"
    case .offline: return "Livis Codex 离线"
    case .notLoggedIn: return "Livis 尚未登录"
    }
  }

  var color: NSColor {
    switch self {
    case .online: return .systemGreen
    case .connecting: return .systemOrange
    case .offline, .notLoggedIn: return .systemRed
    }
  }
}

private struct Arguments {
  let projectRoot: String
  let nodeBinary: String
  let stateDirectory: String

  static func parse(_ values: [String]) -> Arguments? {
    func value(after flag: String) -> String? {
      guard let index = values.firstIndex(of: flag), values.indices.contains(index + 1) else {
        return nil
      }
      return values[index + 1]
    }

    guard
      let projectRoot = value(after: "--project-root"),
      let nodeBinary = value(after: "--node"),
      let stateDirectory = value(after: "--state-dir")
    else {
      return nil
    }
    return Arguments(
      projectRoot: projectRoot,
      nodeBinary: nodeBinary,
      stateDirectory: stateDirectory
    )
  }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
  private let arguments: Arguments
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  private let statusMenuItem = NSMenuItem(title: "正在检查状态…", action: nil, keyEquivalent: "")
  private let dashboardMenuItem = NSMenuItem(title: "打开 Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
  private let loginMenuItem = NSMenuItem(title: "登录 Livis…", action: #selector(startLogin), keyEquivalent: "l")
  private var timer: Timer?
  private var gatewayProcess: Process?
  private var loginReminderShown = false
  private var gatewayStartPending = false

  init(arguments: Arguments) {
    self.arguments = arguments
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    configureMenu()
    update(state: .offline)
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      self?.poll()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self, !self.isLoggedIn() else { return }
      self.showLoginReminder()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
    gatewayProcess?.terminationHandler = nil
    if gatewayProcess?.isRunning == true {
      gatewayProcess?.terminate()
    }
  }

  private func configureMenu() {
    statusMenuItem.isEnabled = false
    dashboardMenuItem.target = self
    dashboardMenuItem.image = NSImage(systemSymbolName: "rectangle.3.group", accessibilityDescription: "Dashboard")
    loginMenuItem.target = self
    loginMenuItem.image = NSImage(systemSymbolName: "person.crop.circle.badge.checkmark", accessibilityDescription: "登录")

    let quitItem = NSMenuItem(title: "退出菜单栏", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self

    menu.addItem(statusMenuItem)
    menu.addItem(.separator())
    menu.addItem(dashboardMenuItem)
    menu.addItem(loginMenuItem)
    menu.addItem(.separator())
    menu.addItem(quitItem)
    menu.autoenablesItems = false
    statusItem.menu = menu
  }

  private func poll() {
    guard isLoggedIn() else {
      update(state: .notLoggedIn)
      return
    }

    let url = dashboardURL().appendingPathComponent("api/status")
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let httpResponse = response as? HTTPURLResponse
      let relayReady = data.flatMap { payload -> Bool? in
        guard
          let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let livis = json["livis"] as? [String: Any]
        else {
          return nil
        }
        return livis["relayReady"] as? Bool
      }
      DispatchQueue.main.async {
        guard let self else { return }
        if httpResponse?.statusCode == 200 {
          self.gatewayStartPending = false
          self.update(state: relayReady == true ? .online : .connecting)
        } else {
          self.update(state: .offline)
          self.startGatewayIfNeeded()
        }
      }
    }.resume()
  }

  private func isLoggedIn() -> Bool {
    let tokenURL = URL(fileURLWithPath: arguments.stateDirectory).appendingPathComponent("tokens.json")
    guard
      let data = try? Data(contentsOf: tokenURL),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let refreshToken = json["refreshToken"] as? String
    else {
      return false
    }
    return !refreshToken.isEmpty
  }

  private func startGatewayIfNeeded() {
    guard !gatewayStartPending, gatewayProcess?.isRunning != true, isLoggedIn() else { return }
    gatewayStartPending = true

    let process = Process()
    process.executableURL = URL(fileURLWithPath: arguments.nodeBinary)
    process.arguments = [
      URL(fileURLWithPath: arguments.projectRoot).appendingPathComponent("src/cli.js").path,
      "start",
    ]
    process.currentDirectoryURL = URL(fileURLWithPath: arguments.projectRoot)
    process.environment = gatewayEnvironment()

    let logHandle = openLog(named: "gateway.log")
    process.standardOutput = logHandle
    process.standardError = logHandle
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.gatewayProcess = nil
        self?.gatewayStartPending = false
      }
    }

    do {
      try process.run()
      gatewayProcess = process
    } catch {
      gatewayStartPending = false
      appendMenuLog("无法启动网关：\(error.localizedDescription)")
    }
  }

  private func gatewayEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let nodeDirectory = URL(fileURLWithPath: arguments.nodeBinary).deletingLastPathComponent().path
    let currentPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    environment["PATH"] = "\(nodeDirectory):/opt/homebrew/bin:/usr/local/bin:\(currentPath)"
    environment["LIVIS_CODEX_HOME"] = arguments.stateDirectory
    return environment
  }

  private func dashboardURL() -> URL {
    let configURL = URL(fileURLWithPath: arguments.stateDirectory).appendingPathComponent("config.json")
    if
      let data = try? Data(contentsOf: configURL),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let dashboard = json["dashboard"] as? [String: Any]
    {
      let configuredHost = dashboard["host"] as? String ?? "127.0.0.1"
      let host = ["0.0.0.0", "::", "[::]"].contains(configuredHost) ? "127.0.0.1" : configuredHost
      let port = dashboard["port"] as? Int ?? 8765
      if let url = URL(string: "http://\(host):\(port)") {
        return url
      }
    }
    return URL(string: "http://127.0.0.1:8765")!
  }

  private func update(state: GatewayState) {
    let statusTitle = NSMutableAttributedString(
      string: "●",
      attributes: [.foregroundColor: state.color]
    )
    statusTitle.append(NSAttributedString(
      string: "  \(state.title)",
      attributes: [.foregroundColor: NSColor.labelColor]
    ))
    statusMenuItem.attributedTitle = statusTitle
    statusItem.button?.image = statusImage(color: state.color)
    statusItem.button?.toolTip = state.title
    dashboardMenuItem.isEnabled = state == .online || state == .connecting
    loginMenuItem.isHidden = state != .notLoggedIn
  }

  private func statusImage(color: NSColor) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
      color.setFill()
      NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
      NSColor.white.setStroke()
      let wave = NSBezierPath()
      wave.lineWidth = 1.5
      wave.move(to: NSPoint(x: 5, y: 9))
      wave.curve(
        to: NSPoint(x: 13, y: 9),
        controlPoint1: NSPoint(x: 7, y: 4),
        controlPoint2: NSPoint(x: 11, y: 14)
      )
      wave.stroke()
      return true
    }
    image.isTemplate = false
    return image
  }

  private func showLoginReminder() {
    guard !loginReminderShown else { return }
    loginReminderShown = true
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Livis 尚未登录"
    alert.informativeText = "完成登录后，Livis Codex 网关会自动启动并在菜单栏显示在线状态。"
    alert.addButton(withTitle: "立即登录")
    alert.addButton(withTitle: "稍后")
    if alert.runModal() == .alertFirstButtonReturn {
      startLogin()
    }
  }

  @objc private func openDashboard() {
    NSWorkspace.shared.open(dashboardURL())
  }

  @objc private func startLogin() {
    let cli = URL(fileURLWithPath: arguments.projectRoot).appendingPathComponent("src/cli.js").path
    let command = "\(shellQuote(arguments.nodeBinary)) \(shellQuote(cli)) login"
    let script = """
    tell application "Terminal"
      activate
      do script "\(appleScriptQuote(command))"
    end tell
    """
    var error: NSDictionary?
    NSAppleScript(source: script)?.executeAndReturnError(&error)
    if let error {
      appendMenuLog("无法打开登录终端：\(error)")
    }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func shellQuote(_ value: String) -> String {
    return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  private func appleScriptQuote(_ value: String) -> String {
    return value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
  }

  private func logDirectory() -> URL {
    return URL(fileURLWithPath: arguments.stateDirectory).appendingPathComponent("logs")
  }

  private func openLog(named name: String) -> FileHandle {
    let directory = logDirectory()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(name)
    if !FileManager.default.fileExists(atPath: file.path) {
      FileManager.default.createFile(atPath: file.path, contents: nil)
    }
    let handle = (try? FileHandle(forWritingTo: file)) ?? FileHandle.nullDevice
    _ = try? handle.seekToEnd()
    return handle
  }

  private func appendMenuLog(_ message: String) {
    let handle = openLog(named: "menubar.log")
    defer { try? handle.close() }
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    if let data = line.data(using: .utf8) {
      try? handle.write(contentsOf: data)
    }
  }
}

guard let arguments = Arguments.parse(CommandLine.arguments) else {
  fputs("Usage: LivisCodexMenuBar --project-root PATH --node PATH --state-dir PATH\n", stderr)
  exit(2)
}

let application = NSApplication.shared
private let delegate = AppDelegate(arguments: arguments)
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
