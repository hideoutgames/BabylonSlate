import SwiftUI
import WebKit

/**
 * An exported Haptic game: one full-screen web view that plays the web game
 * packed in the app's `game` folder, served from `app://game/` with the
 * cross-origin isolation headers and Content Security Policy desktop games
 * use. Links the player follows to other sites open in Safari; the page and
 * its frames cannot navigate away.
 */
@main
struct HapticGameApp: App {
    var body: some Scene {
        WindowGroup {
            GameView()
                .ignoresSafeArea()
                .statusBarHidden()
                .persistentSystemOverlays(.hidden)
                .background(Color.black)
        }
    }
}

struct GameView: UIViewRepresentable {
    func makeCoordinator() -> GameNavigation { GameNavigation() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(GameFiles(), forURLScheme: GameFiles.scheme)
        // Games start their audio without waiting for a tap, as installed apps do.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.load(URLRequest(url: URL(string: "\(GameFiles.scheme)://\(GameFiles.host)/index.html")!))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

final class GameNavigation: NSObject, WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == GameFiles.scheme && url.host == GameFiles.host { return decisionHandler(.allow) }
        // A link the player follows in the page, or to a new window (no target frame), opens in Safari. A frame
        // navigating elsewhere is refused without leaving the game.
        if action.targetFrame?.isMainFrame ?? true { openExternally(url) }
        decisionHandler(.cancel)
    }

    // window.open: the game's links open in Safari, never in a second view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    // The page's process crashed or was reclaimed: start the game again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func openExternally(_ url: URL) {
        if url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
    }
}

/**
 * The bundle's `game` folder at `app://game/`; nothing outside it is served.
 * Files are read on a background queue so a large data file never stalls the
 * main thread, and a task WebKit stopped meanwhile is never answered (WebKit
 * raises an exception for that).
 */
final class GameFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    static let host = "game"
    /**
     * Exported desktop games' policy (`playerContentSecurityPolicy("'none'")` in
     * apps/desktop/src/content-security-policy.ts): the game's own scripts, any
     * HTTPS or secure WebSocket host for its network requests, no remote scripts
     * or frames. content-security-policy.test.ts fails when this copy differs.
     */
    static let contentSecurityPolicy = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob: https: wss:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
    private let root = Bundle.main.bundleURL.appendingPathComponent("game", isDirectory: true).standardizedFileURL
    private let reads = DispatchQueue(label: "game-files", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    /** Tasks started and neither answered nor stopped. */
    private var active = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock()
        active.insert(ObjectIdentifier(task))
        lock.unlock()
        guard let url = task.request.url, url.host == GameFiles.host else { return respond(task, status: 404, data: Data(), type: "text/plain") }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/") else { return respond(task, status: 404, data: Data(), type: "text/plain") }
        let type = GameFiles.mimeType(file.pathExtension.lowercased())
        reads.async {
            let data = try? Data(contentsOf: file, options: .mappedIfSafe)
            DispatchQueue.main.async {
                if let data {
                    self.respond(task, status: 200, data: data, type: type)
                } else {
                    self.respond(task, status: 404, data: Data(), type: "text/plain")
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock()
        active.remove(ObjectIdentifier(task))
        lock.unlock()
    }

    /** Answers `task` once, unless WebKit stopped it first. */
    private func respond(_ task: WKURLSchemeTask, status: Int, data: Data, type: String) {
        lock.lock()
        let answerable = active.remove(ObjectIdentifier(task)) != nil
        lock.unlock()
        guard answerable else { return }
        guard let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(data.count),
            "Content-Security-Policy": GameFiles.contentSecurityPolicy,
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
        ]) else { return task.didFailWithError(URLError(.badURL)) }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private static func mimeType(_ fileExtension: String) -> String {
        switch fileExtension {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "ktx2": return "image/ktx2"
        case "ogg": return "audio/ogg"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        default: return "application/octet-stream"
        }
    }
}
