import Capacitor
import Foundation
import UIKit

/// Exports a file the web layer streams in base64 chunks, since WKWebView
/// ignores anchor downloads: `begin` creates an empty temporary file, `append`
/// adds each chunk, and `finish` offers the file in the share sheet (Save to
/// Files among its actions), resolving when the sheet closes. The file's
/// temporary folder is removed when `finish` settles or on `discard`.
@objc(BabylonSlateFileExportPlugin)
public class BabylonSlateFileExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateFileExportPlugin"
    public let jsName = "BabylonSlateFileExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
    ]

    /// Pending exports by id. Each file sits alone in its own folder, so the sheet shows its real name.
    private var exports: [String: URL] = [:]
    private let exportsLock = NSLock()

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("haptic-exports", isDirectory: true)
    }

    override public func load() {
        // Exports a previous launch never finished, for example when the app was closed mid-share.
        try? FileManager.default.removeItem(at: Self.root)
    }

    @objc func begin(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Self.isPlainFileName(name) else {
            call.reject("The export file name is not valid.")
            return
        }
        let id = UUID().uuidString
        let folder = Self.root.appendingPathComponent(id, isDirectory: true)
        let file = folder.appendingPathComponent(name, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown)
            }
        } catch {
            try? FileManager.default.removeItem(at: folder)
            call.reject("Couldn't prepare the file for sharing.", nil, error)
            return
        }
        exportsLock.lock()
        exports[id] = file
        exportsLock.unlock()
        call.resolve(["id": id])
    }

    @objc func append(_ call: CAPPluginCall) {
        guard let file = pendingExport(call.getString("id"), remove: false) else {
            call.reject("The export is no longer available.")
            return
        }
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("The export data is not valid.")
            return
        }
        do {
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            _ = try handle.seekToEnd()
            try handle.write(contentsOf: data)
            call.resolve()
        } catch {
            call.reject("Couldn't prepare the file for sharing.", nil, error)
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let file = pendingExport(call.getString("id"), remove: true) else {
            call.reject("The export is no longer available.")
            return
        }
        // Capacitor invokes plugin methods on its bridge queue, not UIKit's queue.
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil else {
                Self.removeExport(file)
                call.reject("Sharing is unavailable right now.")
                return
            }
            var top = presenter
            while let presented = top.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            var settled = false
            sheet.completionWithItemsHandler = { _, completed, _, error in
                guard !settled else { return }
                settled = true
                Self.removeExport(file)
                if let error = error, !completed {
                    call.reject("Couldn't share the file.", nil, error)
                    return
                }
                call.resolve(["result": completed ? "shared" : "cancelled"])
            }
            // On iPad the sheet is a popover and needs a source; centre it without an arrow.
            if let popover = sheet.popoverPresentationController {
                let bounds = presenter.view.bounds
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            top.present(sheet, animated: true, completion: nil)
        }
    }

    @objc func discard(_ call: CAPPluginCall) {
        if let file = pendingExport(call.getString("id"), remove: true) {
            Self.removeExport(file)
        }
        call.resolve()
    }

    private func pendingExport(_ id: String?, remove: Bool) -> URL? {
        guard let id = id else { return nil }
        exportsLock.lock()
        defer { exportsLock.unlock() }
        return remove ? exports.removeValue(forKey: id) : exports[id]
    }

    private static func removeExport(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    /// One path component: the web layer names the file, never where it goes.
    private static func isPlainFileName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 255 && name != "." && name != ".."
            && !name.contains("/") && !name.contains("\0")
    }
}
