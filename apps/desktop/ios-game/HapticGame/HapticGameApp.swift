import SwiftUI
import WebKit

/**
 * An exported Haptic game: one full-screen web view that plays the web game
 * packed in the app's `game` folder, served from `app://game/` with the
 * cross-origin isolation headers the editor and desktop games use. Links to
 * other sites open in Safari; the page cannot navigate away.
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
        openExternally(url)
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

/** The bundle's `game` folder at `app://game/`; nothing outside it is served. */
final class GameFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    static let host = "game"
    private let root = Bundle.main.bundleURL.appendingPathComponent("game", isDirectory: true).standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == GameFiles.host else { return respond(task, status: 404, data: Data(), type: "text/plain") }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return respond(task, status: 404, data: Data(), type: "text/plain")
        }
        respond(task, status: 200, data: data, type: GameFiles.mimeType(file.pathExtension.lowercased()))
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, status: Int, data: Data, type: String) {
        guard let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(data.count),
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
