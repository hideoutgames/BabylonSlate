import Capacitor
import Foundation
import UniformTypeIdentifiers

@objc(BabylonSlateScopedStoragePlugin)
public class BabylonSlateScopedStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateScopedStoragePlugin"
    public let jsName = "BabylonSlateScopedStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importBookmark", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rmdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
    ]

    private var pendingPickCall: CAPPluginCall?

    // MARK: - Folder handles

    @objc func pickFolder(_ call: CAPPluginCall) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = self
        pendingPickCall = call
        bridge?.viewController?.present(picker, animated: true, completion: nil)
    }

    @objc func openFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", "NOT_FOUND")
            return
        }
        guard let (folderUrl, _) = resolveFolder(id: id, call: call) else { return }
        guard let name = folderName(id: id) ?? folderUrl.lastPathComponent.nilIfEmpty else {
            call.reject("Could not read folder name", "UNREACHABLE")
            return
        }
        call.resolve(["folder": ["id": id, "name": name]])
    }

    @objc func importBookmark(_ call: CAPPluginCall) {
        guard let bookmark = call.getString("bookmark"), !bookmark.isEmpty,
              let data = Data(base64Encoded: bookmark) else {
            call.reject("bookmark is required", "NOT_FOUND")
            return
        }
        do {
            var isStale = false
            let url = try URL(resolvingBookmarkData: data,
                              options: [],
                              relativeTo: nil,
                              bookmarkDataIsStale: &isStale)
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            guard let folder = storeFolder(url: url, name: call.getString("name"), renewing: isStale) else {
                call.reject("Bookmark is stale", "STALE")
                return
            }
            call.resolve(["folder": ["id": folder.id, "name": folder.name]])
        } catch {
            call.reject("Invalid bookmark", "STALE", error)
        }
    }

    // MARK: - File operations

    @objc func readFile(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }

        withCoordinatedRead(folderUrl: folderUrl, path: path, execute: { target in
            try Data(contentsOf: target)
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success(let data):
                let encoding = call.getString("encoding") ?? "utf8"
                if encoding == "base64" {
                    call.resolve(["data": data.base64EncodedString()])
                } else {
                    guard let text = String(data: data, encoding: .utf8) else {
                        call.reject("File is not valid UTF-8", "UNREACHABLE")
                        return
                    }
                    call.resolve(["data": text])
                }
            }
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call),
              let data = call.getString("data") else {
            call.reject("folder, path and data are required")
            return
        }
        let encoding = call.getString("encoding") ?? "utf8"
        let payload: Data
        if encoding == "base64" {
            guard let bytes = Data(base64Encoded: data) else {
                call.reject("data is not valid base64")
                return
            }
            payload = bytes
        } else {
            payload = Data(data.utf8)
        }

        withCoordinatedWrite(folderUrl: folderUrl, path: path, execute: { target in
            let parent = target.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: nil)
            try payload.write(to: target, options: .atomic)
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success:
                call.resolve()
            }
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        let recursive = call.getBool("recursive") ?? false

        withCoordinatedWrite(folderUrl: folderUrl, path: path, execute: { target in
            try FileManager.default.createDirectory(at: target,
                                                    withIntermediateDirectories: recursive,
                                                    attributes: nil)
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success:
                call.resolve()
            }
        }
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }

        withCoordinatedWrite(folderUrl: folderUrl, path: path, options: .forDeleting, execute: { target in
            try FileManager.default.removeItem(at: target)
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success:
                call.resolve()
            }
        }
    }

    @objc func rmdir(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }

        withCoordinatedWrite(folderUrl: folderUrl, path: path, options: .forDeleting, execute: { target in
            try FileManager.default.removeItem(at: target)
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success:
                call.resolve()
            }
        }
    }

    @objc func readdir(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }

        withCoordinatedRead(folderUrl: folderUrl, path: path, options: .withoutChanges, execute: { target in
            let names = try FileManager.default.contentsOfDirectory(atPath: target.path)
            return names.map { name -> [String: Any] in
                let item = target.appendingPathComponent(name)
                return self.dirEntry(url: item, name: name)
            }
        }) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.reject(call, error: error)
            case .success(let entries):
                call.resolve(["entries": entries])
            }
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        let url = path.isEmpty ? folderUrl : folderUrl.appendingPathComponent(path)

        let accessing = folderUrl.startAccessingSecurityScopedResource()
        defer { if accessing { folderUrl.stopAccessingSecurityScopedResource() } }

        let (exists, isDirectory) = fileExists(at: url)
        guard exists else {
            call.reject("File not found", "NOT_FOUND")
            return
        }

        let stat = fileStat(url: url)
        call.resolve(["isDir": isDirectory,
                      "size": stat.size as Any,
                      "mtime": stat.mtime as Any])
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        let url = path.isEmpty ? folderUrl : folderUrl.appendingPathComponent(path)

        let accessing = folderUrl.startAccessingSecurityScopedResource()
        defer { if accessing { folderUrl.stopAccessingSecurityScopedResource() } }

        let (exists, isDirectory) = fileExists(at: url)
        call.resolve(["exists": exists, "isDirectory": isDirectory])
    }

    // MARK: - Helpers

    private func folderAndPath(call: CAPPluginCall) -> (URL, String)? {
        guard let id = call.getString("folder"), !id.isEmpty,
              let (folderUrl, _) = resolveFolder(id: id, call: call) else { return nil }
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return nil
        }
        return (folderUrl, path)
    }

    private func resolveFolder(id: String, call: CAPPluginCall) -> (URL, Bool)? {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey(id)) else {
            call.reject("Folder bookmark not found", "NOT_FOUND")
            return nil
        }
        do {
            var isStale = false
            let url = try URL(resolvingBookmarkData: data,
                              options: [],
                              relativeTo: nil,
                              bookmarkDataIsStale: &isStale)
            if isStale {
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                guard let renewed = try? url.bookmarkData(options: [],
                                                           includingResourceValuesForKeys: nil,
                                                           relativeTo: nil) else {
                    call.reject("Bookmark is stale", "STALE")
                    return nil
                }
                UserDefaults.standard.set(renewed, forKey: bookmarkKey(id))
            }
            return (url, isStale)
        } catch {
            call.reject("Could not resolve folder", "STALE", error)
            return nil
        }
    }

    private func storeFolder(url: URL, name: String?, renewing: Bool) -> (id: String, name: String)? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }

        do {
            if renewing {
                _ = try url.bookmarkData(options: [],
                                         includingResourceValuesForKeys: nil,
                                         relativeTo: nil)
            }
            let data = try url.bookmarkData(options: [],
                                            includingResourceValuesForKeys: nil,
                                            relativeTo: nil)
            let id = UUID().uuidString
            let folderName = name ?? url.lastPathComponent
            UserDefaults.standard.set(data, forKey: bookmarkKey(id))
            UserDefaults.standard.set(folderName, forKey: nameKey(id))
            return (id, folderName)
        } catch {
            return nil
        }
    }

    private func folderName(id: String) -> String? {
        return UserDefaults.standard.string(forKey: nameKey(id))
    }

    private func bookmarkKey(_ id: String) -> String { "scoped-bookmark-\(id)" }
    private func nameKey(_ id: String) -> String { "scoped-name-\(id)" }

    private func childURL(folderUrl: URL, path: String) -> URL {
        return path.isEmpty ? folderUrl : folderUrl.appendingPathComponent(path)
    }

    private func withCoordinatedRead<T>(folderUrl: URL,
                                        path: String,
                                        options: NSFileCoordinator.ReadingOptions = [],
                                        execute: @escaping (URL) throws -> T,
                                        completion: @escaping (Result<T, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let url = self.childURL(folderUrl: folderUrl, path: path)
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            let accessing = folderUrl.startAccessingSecurityScopedResource()
            defer { if accessing { folderUrl.stopAccessingSecurityScopedResource() } }

            self.materializeIfUbiquitous(url)

            var value: T?
            var caughtError: Error?
            coordinator.coordinate(readingItemAt: url, options: options, error: &coordinatorError) { target in
                do {
                    value = try execute(target)
                } catch {
                    caughtError = error
                }
            }
            if let error = coordinatorError ?? caughtError {
                completion(.failure(error))
            } else if let value = value {
                completion(.success(value))
            } else {
                completion(.failure(NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError)))
            }
        }
    }

    private func withCoordinatedWrite<T>(folderUrl: URL,
                                         path: String,
                                         options: NSFileCoordinator.WritingOptions = [],
                                         execute: @escaping (URL) throws -> T,
                                         completion: @escaping (Result<T, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let url = self.childURL(folderUrl: folderUrl, path: path)
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            let accessing = folderUrl.startAccessingSecurityScopedResource()
            defer { if accessing { folderUrl.stopAccessingSecurityScopedResource() } }

            self.materializeIfUbiquitous(url)

            var value: T?
            var caughtError: Error?
            coordinator.coordinate(writingItemAt: url, options: options, error: &coordinatorError) { target in
                do {
                    value = try execute(target)
                } catch {
                    caughtError = error
                }
            }
            if let error = coordinatorError ?? caughtError {
                completion(.failure(error))
            } else if let value = value {
                completion(.success(value))
            } else {
                completion(.failure(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError)))
            }
        }
    }

    private func materializeIfUbiquitous(_ url: URL) {
        guard FileManager.default.isUbiquitousItem(at: url) else { return }
        do {
            try FileManager.default.startDownloadingUbiquitousItem(at: url)
        } catch {
            // Ignore; the read/write will surface the real error if the item is unavailable.
        }
        let deadline = Date(timeIntervalSinceNow: 5)
        while Date() < deadline {
            if let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]),
               values.ubiquitousItemDownloadingStatus == .current {
                return
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    private func fileExists(at url: URL) -> (exists: Bool, isDirectory: Bool) {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
        return (exists, isDir.boolValue)
    }

    private func dirEntry(url: URL, name: String) -> [String: Any] {
        let (exists, isDir) = fileExists(at: url)
        var entry: [String: Any] = ["name": name, "isDir": isDir]
        if !isDir, exists {
            let stat = fileStat(url: url)
            if let size = stat.size { entry["size"] = size }
            if let mtime = stat.mtime { entry["mtime"] = mtime }
        }
        return entry
    }

    private struct FileStat {
        var size: Int64?
        var mtime: Int64?
    }

    private func fileStat(url: URL) -> FileStat {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            var result = FileStat()
            if let size = attrs[.size] as? NSNumber {
                result.size = size.int64Value
            }
            if let mtime = attrs[.modificationDate] as? Date {
                result.mtime = Int64(mtime.timeIntervalSince1970 * 1000)
            }
            return result
        } catch {
            return FileStat()
        }
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
        let nsError = error as NSError
        let notFoundCodes: [Int] = [260, 4, 2, 43]
        if nsError.domain == NSCocoaErrorDomain && notFoundCodes.contains(nsError.code) {
            call.reject("File not found", "NOT_FOUND", error)
        } else {
            call.reject(error.localizedDescription, "UNREACHABLE", error)
        }
    }
}

extension BabylonSlateScopedStoragePlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, let call = pendingPickCall else { return }
        pendingPickCall = nil
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            guard let folder = self.storeFolder(url: url, name: nil, renewing: false) else {
                DispatchQueue.main.async {
                    call.reject("Could not create folder bookmark", "UNREACHABLE")
                }
                return
            }
            DispatchQueue.main.async {
                call.resolve(["folder": ["id": folder.id, "name": folder.name]])
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPickCall else { return }
        pendingPickCall = nil
        call.reject("Cancelled", "CANCELLED")
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
