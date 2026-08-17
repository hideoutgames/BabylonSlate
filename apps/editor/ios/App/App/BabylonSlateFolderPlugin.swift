import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

@objc(BabylonSlateFolderPlugin)
public class BabylonSlateFolderPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "BabylonSlateFolderPlugin"
    public let jsName = "BabylonSlateFolder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rmdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
    ]

    private let staleBookmarkCode = "STALE_BOOKMARK"
    private var pendingPickCall: CAPPluginCall?
    private var activeFolderURL: URL?

    @objc func pickFolder(_ call: CAPPluginCall) {
        guard let viewController = bridge?.viewController else {
            call.reject("Unable to present folder picker", "PICKER_UNAVAILABLE")
            return
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        pendingPickCall = call
        viewController.present(picker, animated: true)
    }

    @objc func resolveFolder(_ call: CAPPluginCall) {
        guard let bookmark = call.getString("bookmark"),
              let bookmarkData = Data(base64Encoded: bookmark) else {
            rejectStale(call, message: "Folder bookmark is missing or invalid")
            return
        }

        do {
            stopAccessingFolder()
            var stale = false
            let folderURL = try URL(
                resolvingBookmarkData: bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            guard folderURL.startAccessingSecurityScopedResource() else {
                rejectStale(call, message: "Unable to access folder bookmark")
                return
            }
            activeFolderURL = folderURL

            var refreshedBookmark = bookmark
            if stale {
                do {
                    let data = try folderURL.bookmarkData(
                        options: [],
                        includingResourceValuesForKeys: nil,
                        relativeTo: nil
                    )
                    refreshedBookmark = data.base64EncodedString()
                } catch {
                    stopAccessingFolder()
                    rejectStale(call, message: "Folder bookmark is stale")
                    return
                }
            }
            call.resolve([
                "folder": [
                    "id": refreshedBookmark,
                    "name": folderURL.lastPathComponent,
                ],
                "stale": stale,
            ])
        } catch {
            rejectStale(call, message: "Folder bookmark is stale")
        }
    }

    @objc func releaseFolder(_ call: CAPPluginCall) {
        stopAccessingFolder()
        call.resolve()
    }

    @objc func readFile(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            let encoding = call.getString("encoding") ?? "utf8"
            var data: Data?
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                readingItemAt: url,
                options: [],
                error: &coordinationError
            ) { coordinatedURL in
                data = try? Data(contentsOf: coordinatedURL)
            }
            if let coordinationError {
                throw coordinationError
            }
            guard let data else {
                throw CocoaError(.fileReadUnknown)
            }
            let value: String
            if encoding == "base64" {
                value = data.base64EncodedString()
            } else {
                guard let decoded = String(data: data, encoding: .utf8) else {
                    throw CocoaError(.fileReadInapplicableStringEncoding)
                }
                value = decoded
            }
            call.resolve(["data": value])
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            guard let value = call.getString("data") else {
                call.reject("File data is required", "INVALID_DATA")
                return
            }
            let encoding = call.getString("encoding") ?? "utf8"
            let data: Data
            if encoding == "base64" {
                guard let decoded = Data(base64Encoded: value) else {
                    call.reject("File data is not valid base64", "INVALID_DATA")
                    return
                }
                data = decoded
            } else {
                data = Data(value.utf8)
            }
            let parent = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: parent,
                withIntermediateDirectories: true,
                attributes: nil
            )
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            let options: NSFileCoordinator.WritingOptions = FileManager.default.fileExists(atPath: url.path)
                ? [.forReplacing]
                : []
            coordinator.coordinate(
                writingItemAt: url,
                options: options,
                error: &coordinationError
            ) { coordinatedURL in
                do {
                    try data.write(to: coordinatedURL, options: .atomic)
                } catch {
                    coordinationError = error as NSError
                }
            }
            if let coordinationError {
                throw coordinationError
            }
            call.resolve()
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            var exists = false
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                readingItemAt: url,
                options: [],
                error: &coordinationError
            ) { coordinatedURL in
                exists = FileManager.default.fileExists(atPath: coordinatedURL.path)
            }
            if let coordinationError, coordinationError.code != NSFileNoSuchFileError {
                throw coordinationError
            }
            call.resolve(["exists": exists])
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    @objc func readdir(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            var files: [[String: Any]] = []
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                readingItemAt: url,
                options: [],
                error: &coordinationError
            ) { coordinatedURL in
                guard let urls = try? FileManager.default.contentsOfDirectory(
                    at: coordinatedURL,
                    includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
                    options: [.skipsHiddenFiles]
                ) else {
                    return
                }
                files = urls.compactMap { childURL in
                    guard let values = try? childURL.resourceValues(
                        forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
                    ) else {
                        return nil
                    }
                    return [
                        "name": childURL.lastPathComponent,
                        "isDir": values.isDirectory ?? false,
                        "size": values.fileSize ?? 0,
                        "mtime": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                    ]
                }
            }
            if let coordinationError {
                throw coordinationError
            }
            call.resolve(["entries": files])
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                writingItemAt: url,
                options: [],
                error: &coordinationError
            ) { coordinatedURL in
                do {
                    try FileManager.default.createDirectory(
                        at: coordinatedURL,
                        withIntermediateDirectories: call.getBool("recursive") ?? true,
                        attributes: nil
                    )
                } catch {
                    coordinationError = error as NSError
                }
            }
            if let coordinationError {
                throw coordinationError
            }
            call.resolve()
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        remove(call, directory: false)
    }

    @objc func rmdir(_ call: CAPPluginCall) {
        remove(call, directory: true)
    }

    @objc func stat(_ call: CAPPluginCall) {
        do {
            let url = try fileURL(for: call)
            var result: [String: Any]?
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                readingItemAt: url,
                options: [],
                error: &coordinationError
            ) { coordinatedURL in
                guard let values = try? coordinatedURL.resourceValues(
                    forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
                ) else {
                    return
                }
                result = [
                    "type": values.isDirectory == true ? "directory" : "file",
                    "size": values.fileSize ?? 0,
                    "mtime": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                ]
            }
            if let coordinationError {
                throw coordinationError
            }
            guard let result else {
                throw CocoaError(.fileNoSuchFile)
            }
            call.resolve(result)
        } catch {
            rejectOperationError(call, error: error)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPickCall else {
            controller.dismiss(animated: true)
            return
        }
        pendingPickCall = nil
        guard let url = urls.first else {
            call.reject("No folder was selected", "PICKER_CANCELLED")
            return
        }
        do {
            let bookmarkData = try url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            stopAccessingFolder()
            guard url.startAccessingSecurityScopedResource() else {
                rejectStale(call, message: "Unable to access selected folder")
                return
            }
            activeFolderURL = url
            call.resolve([
                "folder": [
                    "id": bookmarkData.base64EncodedString(),
                    "name": url.lastPathComponent,
                ],
            ])
        } catch {
            call.reject("Unable to create folder bookmark", "PICKER_FAILED")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingPickCall?.reject("Folder picker was cancelled", "PICKER_CANCELLED")
        pendingPickCall = nil
    }

    deinit {
        stopAccessingFolder()
    }

    private func remove(_ call: CAPPluginCall, directory: Bool) {
        do {
            let url = try fileURL(for: call)
            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                writingItemAt: url,
                options: [.forDeleting],
                error: &coordinationError
            ) { coordinatedURL in
                do {
                    try FileManager.default.removeItem(at: coordinatedURL)
                } catch {
                    coordinationError = error as NSError
                }
            }
            if let coordinationError {
                throw coordinationError
            }
            call.resolve()
        } catch {
            rejectOperationError(call, error: error)
        }
        _ = directory
    }

    private func fileURL(for call: CAPPluginCall) throws -> URL {
        guard let folderURL = activeFolderURL else {
            throw FolderPluginError.missingScope
        }
        let path = call.getString("path") ?? ""
        let components = path.split(separator: "/").map(String.init)
        guard !components.contains("..") else {
            throw FolderPluginError.invalidPath
        }
        return components.reduce(folderURL) { url, component in
            url.appendingPathComponent(component, isDirectory: false)
        }
    }

    private func stopAccessingFolder() {
        activeFolderURL?.stopAccessingSecurityScopedResource()
        activeFolderURL = nil
    }

    private func rejectStale(_ call: CAPPluginCall, message: String) {
        call.reject(message, staleBookmarkCode)
    }

    private func rejectOperationError(_ call: CAPPluginCall, error: Error) {
        if case FolderPluginError.missingScope = error {
            rejectStale(call, message: "Folder security scope is unavailable")
        } else {
            call.reject(error.localizedDescription, "IO_ERROR")
        }
    }
}

private enum FolderPluginError: Error {
    case missingScope
    case invalidPath
}
