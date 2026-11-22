import Capacitor
import CryptoKit
import Foundation
import Darwin
import Security
import UniformTypeIdentifiers

private enum ScopedStoragePluginError: LocalizedError {
    case accessRevoked
    case stale
    case invalidPath(String)

    var errorDescription: String? {
        switch self {
        case .accessRevoked:
            return "Folder access has been revoked"
        case .stale:
            return "Project folder is no longer available; reconnect required"
        case .invalidPath(let path):
            return "Path escapes project root: \(path)"
        }
    }
}

@objc(BabylonSlateScopedStoragePlugin)
public class BabylonSlateScopedStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateScopedStoragePlugin"
    public let jsName = "BabylonSlateScopedStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFileRange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readDocumentsRange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rmdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transferFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelTransfer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeRandomObject", returnType: CAPPluginReturnPromise),
    ]

    private var pendingPickCall: CAPPluginCall?
    /// Git LFS objects streamed between a URL and a file in app storage.
    private lazy var fileTransfers = ProjectFileTransfers(plugin: self)
    /// Folders resolved this session, each holding one security-scoped access.
    /// Every bookmark resolution issues a new sandbox extension, and iOS caps
    /// them per process: resolving per file operation exhausted the cap during
    /// one project scaffold, so later folders failed as revoked until relaunch.
    private var resolvedFolders: [String: URL] = [:]
    private let resolvedFoldersLock = NSLock()
    /// One bridge transfer, whole-file or ranged, never exceeds this.
    private static let maxTransferBytes: Int64 = 512 * 1024 * 1024

    // MARK: - Folder handles

    @objc func pickFolder(_ call: CAPPluginCall) {
        // Capacitor invokes plugin methods on its bridge queue, not UIKit's queue.
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let presenter = self.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil else {
                call.reject("Folder picker is unavailable", "UNREACHABLE")
                return
            }
            guard presenter.presentedViewController == nil else {
                call.reject("A native picker is already open", "UNREACHABLE")
                return
            }
            if let stale = self.pendingPickCall {
                // No picker is on screen, so its delegate callback will never arrive.
                self.pendingPickCall = nil
                stale.reject("Cancelled", "CANCELLED")
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingPickCall = call
            presenter.present(picker, animated: true, completion: nil)
        }
    }

    @objc func openFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", "NOT_FOUND")
            return
        }
        guard let (folderUrl, _) = resolveFolder(id: id, call: call) else { return }
        withCoordinatedRead(folderUrl: folderUrl, path: "", allowRoot: true, materialize: false, execute: { _ in
            self.folderName(id: id) ?? folderUrl.lastPathComponent
        }) { result in
            switch result {
            case .success(let name): call.resolve(["folder": ["id": id, "name": name]])
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    // MARK: - File operations

    @objc func readFileRange(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        // Ranges need file contents, so an evicted iCloud item is downloaded first.
        withCoordinatedRead(folderUrl: folderUrl, path: path, execute: { target in
            try self.readRange(target: target, call: call)
        }) { result in
            switch result {
            case .success(let value): call.resolve(value)
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    @objc func readDocumentsRange(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), path.hasPrefix("Haptic/projects/"),
              ["DOCUMENTS", "DATA"].contains(call.getString("directory") ?? "") else {
            call.reject("Invalid Documents range location", "UNREACHABLE")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let root = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
                let target = try self.childURL(folderUrl: root, path: path)
                let coordinator = NSFileCoordinator(filePresenter: nil)
                var coordinationError: NSError?
                var result: Result<[String: Any], Error>?
                coordinator.coordinate(readingItemAt: target, options: [], error: &coordinationError) { url in
                    result = Result { try self.readRange(target: self.confinedURL(url, folderUrl: root), call: call) }
                }
                if let error = coordinationError { throw error }
                guard let result = result else { throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError) }
                call.resolve(try result.get())
            } catch { self.reject(call, error: error) }
        }
    }

    private func rangeFailure(_ message: String, revisionChanged: Bool = false) -> NSError {
        NSError(domain: "BabylonSlate.StorageRange", code: revisionChanged ? 2 : 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func descriptorRevision(_ descriptor: Int32) throws -> (String, Int64) {
        var value = Darwin.stat()
        guard Darwin.fstat(descriptor, &value) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard (value.st_mode & S_IFMT) == S_IFREG else { throw rangeFailure("Bounded reads require a regular file") }
        let revision = "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)"
        return (revision, value.st_size)
    }

    private func readRange(target: URL, call: CAPPluginCall) throws -> [String: Any] {
        guard let offset = call.getDouble("offset"), let length = call.getDouble("length"),
              offset.isFinite, length.isFinite, offset >= 0, length >= 0,
              offset.rounded(.down) == offset, length.rounded(.down) == length,
              offset + length <= 9007199254740991, length <= Double(Self.maxTransferBytes) else {
            throw rangeFailure("Invalid storage byte range")
        }
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        let (revision, size) = try descriptorRevision(handle.fileDescriptor)
        if let expected = call.getString("expectedRevision"), expected != revision {
            throw rangeFailure("Source revision changed: \(target.lastPathComponent)", revisionChanged: true)
        }
        guard offset + length <= Double(size) else { throw rangeFailure("Storage byte range exceeds file size") }
        try handle.seek(toOffset: UInt64(offset))
        var bytes = Data()
        bytes.reserveCapacity(Int(length))
        do {
            while bytes.count < Int(length) {
                guard let part = try handle.read(upToCount: Int(length) - bytes.count), !part.isEmpty else {
                    throw rangeFailure("Unexpected end of file")
                }
                bytes.append(part)
            }
            guard try descriptorRevision(handle.fileDescriptor).0 == revision else { throw rangeFailure("Source revision changed during read", revisionChanged: true) }
            let current = try FileHandle(forReadingFrom: target)
            defer { try? current.close() }
            guard try descriptorRevision(current.fileDescriptor).0 == revision else { throw rangeFailure("Source revision changed during read", revisionChanged: true) }
            return ["data": bytes.base64EncodedString(), "totalSize": size, "revision": revision, "actualBytesRead": bytes.count]
        } catch {
            let failure = error as NSError
            var information = failure.userInfo
            information["actualBytesRead"] = bytes.count
            throw NSError(domain: failure.domain, code: failure.code, userInfo: information)
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }

        withCoordinatedRead(folderUrl: folderUrl, path: path, execute: { target -> Data in
            let size = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size <= Self.maxTransferBytes else { throw self.rangeFailure("File is too large to read at once") }
            return try Data(contentsOf: target)
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

        withCoordinatedRead(folderUrl: folderUrl,
                            path: path,
                            options: .withoutChanges,
                            allowRoot: true,
                            execute: { target in
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
        withCoordinatedRead(folderUrl: folderUrl, path: path, allowRoot: true, materialize: false, execute: { target in
            try self.itemMetadata(at: target)
        }) { result in
            switch result {
            case .success(let metadata): call.resolve(metadata)
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        withCoordinatedRead(folderUrl: folderUrl, path: path, allowRoot: true, materialize: false, execute: { target in
            try self.itemMetadata(at: target)
        }) { result in
            switch result {
            case .success(let metadata):
                call.resolve(["exists": true, "isDirectory": metadata["isDir"] ?? false])
            case .failure(let error):
                if self.isNotFound(error), !path.isEmpty {
                    call.resolve(["exists": false, "isDirectory": false])
                } else {
                    self.reject(call, error: error)
                }
            }
        }
    }

    // MARK: - File transfer (Git LFS objects)

    /// A file of a project in app storage, named as `readDocumentsRange` names
    /// one: never a chosen folder (Integrated mode never runs in one), never
    /// the project folder itself, inside Documents after resolving links.
    private func documentsFile(_ call: CAPPluginCall) throws -> URL {
        guard let path = call.getString("path"), path.hasPrefix("Haptic/projects/"),
              path.split(separator: "/").count >= 4,
              ["DOCUMENTS", "DATA"].contains(call.getString("directory") ?? "") else {
            throw ScopedStoragePluginError.invalidPath(call.getString("path") ?? "")
        }
        let root = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        return try childURL(folderUrl: root, path: path)
    }

    @objc func transferFile(_ call: CAPPluginCall) {
        let file: URL
        do { file = try documentsFile(call) } catch { reject(call, error: error); return }
        guard let id = call.getString("id"), !id.isEmpty,
              let method = call.getString("method"), method == "GET" || method == "PUT",
              let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else {
            call.reject("Files are transferred over HTTPS only", "UNREACHABLE")
            return
        }
        var headers: [String: String] = [:]
        for (name, value) in call.getObject("headers") ?? [:] {
            guard let value = value as? String else {
                call.reject("Header values must be text", "UNREACHABLE")
                return
            }
            headers[name] = value
        }
        var expected: (size: Int64, sha256: String)?
        if let size = call.getDouble("expectedSize") {
            guard size >= 0, size.rounded(.down) == size, size <= 9007199254740991,
                  let sha256 = call.getString("expectedSha256"), sha256.count == 64 else {
                call.reject("Invalid expected object", "UNREACHABLE")
                return
            }
            expected = (Int64(size), sha256)
        }
        fileTransfers.start(call: call, id: id, method: method, url: url, headers: headers, file: file, expected: expected)
    }

    @objc func cancelTransfer(_ call: CAPPluginCall) {
        fileTransfers.cancel(id: call.getString("id") ?? "")
        call.resolve()
    }

    /// The Git benchmark's objects: random bytes made and hashed here, so no
    /// object is built in JavaScript or crosses the bridge.
    @objc func writeRandomObject(_ call: CAPPluginCall) {
        let folder: URL
        do { folder = try documentsFile(call) } catch { reject(call, error: error); return }
        guard let size = call.getDouble("size"), size >= 0, size.rounded(.down) == size, size <= 9007199254740991 else {
            call.reject("Invalid size", "UNREACHABLE")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let sha256 = try ProjectFileTransfers.writeRandomFile(in: folder, size: Int64(size))
                call.resolve(["sha256": sha256])
            } catch {
                call.reject(error.localizedDescription, "UNREACHABLE", error)
            }
        }
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
        resolvedFoldersLock.lock()
        let cached = resolvedFolders[id]
        resolvedFoldersLock.unlock()
        if let cached = cached { return (cached, false) }
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey(id)) else {
            call.reject("Folder bookmark not found; reconnect required", "STALE")
            return nil
        }
        do {
            var isStale = false
            let url = try URL(resolvingBookmarkData: data,
                              options: [],
                              relativeTo: nil,
                              bookmarkDataIsStale: &isStale)
            // Held for the session; per-operation start/stop pairs on this URL
            // only adjust its count and issue no new extension.
            guard url.startAccessingSecurityScopedResource() else {
                call.reject("Folder access has been revoked", "ACCESS_REVOKED")
                return nil
            }
            if isStale {
                guard let renewed = try? url.bookmarkData(options: [],
                                                           includingResourceValuesForKeys: nil,
                                                           relativeTo: nil) else {
                    url.stopAccessingSecurityScopedResource()
                    call.reject("Bookmark is stale", "STALE")
                    return nil
                }
                UserDefaults.standard.set(renewed, forKey: bookmarkKey(id))
            }
            resolvedFoldersLock.lock()
            defer { resolvedFoldersLock.unlock() }
            if let existing = resolvedFolders[id] {
                // A concurrent call resolved it first; keep one held access.
                url.stopAccessingSecurityScopedResource()
                return (existing, false)
            }
            resolvedFolders[id] = url
            return (url, isStale)
        } catch {
            call.reject("Could not resolve folder", "STALE", error)
            return nil
        }
    }

    private func storeFolder(url: URL) -> (id: String, name: String)? {
        let accessing = url.startAccessingSecurityScopedResource()
        guard accessing else { return nil }
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }

        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { return nil }
            let data = try url.bookmarkData(options: [],
                                            includingResourceValuesForKeys: nil,
                                            relativeTo: nil)
            let id = UUID().uuidString
            let folderName = url.lastPathComponent
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

    private func childURL(folderUrl: URL, path: String, allowRoot: Bool = false) throws -> URL {
        if path.isEmpty {
            guard allowRoot else { throw ScopedStoragePluginError.invalidPath(path) }
            return folderUrl.resolvingSymlinksInPath().standardizedFileURL
        }
        guard !path.hasPrefix("/"), !path.hasPrefix("\\") else {
            throw ScopedStoragePluginError.invalidPath(path)
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
              !path.contains("\\"), !path.contains("\0") else {
            throw ScopedStoragePluginError.invalidPath(path)
        }

        let root = folderUrl.resolvingSymlinksInPath().standardizedFileURL
        return try confinedURL(root.appendingPathComponent(path), folderUrl: folderUrl, allowRoot: allowRoot)
    }

    private func confinedURL(_ url: URL, folderUrl: URL, allowRoot: Bool = false) throws -> URL {
        let root = folderUrl.resolvingSymlinksInPath().standardizedFileURL
        let target = url.resolvingSymlinksInPath().standardizedFileURL
        let rootComponents = root.pathComponents
        let targetComponents = target.pathComponents
        guard (allowRoot ? targetComponents.count >= rootComponents.count : targetComponents.count > rootComponents.count),
              Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
            throw ScopedStoragePluginError.invalidPath(url.lastPathComponent)
        }
        return target
    }

    private func withCoordinatedRead<T>(folderUrl: URL,
                                        path: String,
                                        options: NSFileCoordinator.ReadingOptions = [],
                                        allowRoot: Bool = false,
                                        materialize: Bool = true,
                                        execute: @escaping (URL) throws -> T,
                                        completion: @escaping (Result<T, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            guard folderUrl.startAccessingSecurityScopedResource() else {
                completion(.failure(ScopedStoragePluginError.accessRevoked))
                return
            }
            defer { folderUrl.stopAccessingSecurityScopedResource() }
            let url: URL
            do {
                try self.validateRoot(folderUrl)
                url = try self.childURL(folderUrl: folderUrl, path: path, allowRoot: allowRoot)
            } catch {
                completion(.failure(self.classifyRootFailure(error, folderUrl: folderUrl)))
                return
            }
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            if materialize { self.materializeIfUbiquitous(url) }

            var value: T?
            var caughtError: Error?
            coordinator.coordinate(readingItemAt: url, options: options, error: &coordinatorError) { target in
                do {
                    try self.validateRoot(folderUrl)
                    value = try execute(self.confinedURL(target, folderUrl: folderUrl, allowRoot: allowRoot))
                } catch {
                    caughtError = error
                }
            }
            if let error = coordinatorError ?? caughtError {
                completion(.failure(self.classifyRootFailure(error, folderUrl: folderUrl)))
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
            guard folderUrl.startAccessingSecurityScopedResource() else {
                completion(.failure(ScopedStoragePluginError.accessRevoked))
                return
            }
            defer { folderUrl.stopAccessingSecurityScopedResource() }
            let url: URL
            do {
                try self.validateRoot(folderUrl)
                url = try self.childURL(folderUrl: folderUrl, path: path)
            } catch {
                completion(.failure(self.classifyRootFailure(error, folderUrl: folderUrl)))
                return
            }
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            self.materializeIfUbiquitous(url)

            var value: T?
            var caughtError: Error?
            coordinator.coordinate(writingItemAt: url, options: options, error: &coordinatorError) { target in
                do {
                    try self.validateRoot(folderUrl)
                    value = try execute(self.confinedURL(target, folderUrl: folderUrl))
                } catch {
                    caughtError = error
                }
            }
            if let error = coordinatorError ?? caughtError {
                completion(.failure(self.classifyRootFailure(error, folderUrl: folderUrl)))
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

    private func itemMetadata(at url: URL) throws -> [String: Any] {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let isDirectory = attributes[.type] as? FileAttributeType == .typeDirectory
        var metadata: [String: Any] = ["isDir": isDirectory]
        if !isDirectory, let size = attributes[.size] as? NSNumber { metadata["size"] = size.int64Value }
        if let date = attributes[.modificationDate] as? Date {
            metadata["mtime"] = Int64(date.timeIntervalSince1970 * 1000)
        }
        return metadata
    }

    // A missing project root is lost access, never an empty project. In particular,
    // writeFile must not recreate a removed root through recursive parent creation.
    private func validateRoot(_ url: URL) throws {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw ScopedStoragePluginError.stale
            }
        } catch {
            if isNotFound(error) { throw ScopedStoragePluginError.stale }
            throw error
        }
    }

    /// Only a root that is missing or unreadable means lost folder access; one
    /// unreadable file keeps its own error so the folder is not marked stale.
    private func classifyRootFailure(_ error: Error, folderUrl: URL) -> Error {
        do { try validateRoot(folderUrl) } catch let rootError {
            return isPermissionDenied(rootError) ? ScopedStoragePluginError.accessRevoked : rootError
        }
        return error
    }

    private func isPermissionDenied(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(error.code)) ||
            (error.domain == NSPOSIXErrorDomain && [1, 13].contains(error.code))
    }

    private func isNotFound(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)) ||
            (error.domain == NSPOSIXErrorDomain && error.code == 2)
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
        let bytesRead = (error as NSError).userInfo["actualBytesRead"] as? Int
        let readData: [String: Any]? = bytesRead.map { ["actualBytesRead": $0] }
        if let storageError = error as? ScopedStoragePluginError {
            switch storageError {
            case .accessRevoked:
                call.reject(storageError.localizedDescription, "ACCESS_REVOKED", error, readData)
            case .stale:
                call.reject(storageError.localizedDescription, "STALE", error, readData)
            case .invalidPath:
                call.reject(storageError.localizedDescription, "UNREACHABLE", error, readData)
            }
            return
        }
        let nsError = error as NSError
        if nsError.domain == "BabylonSlate.StorageRange" && nsError.code == 2 {
            call.reject(error.localizedDescription, "REVISION_CHANGED", error, readData)
        } else if isNotFound(error) {
            call.reject("File not found", "NOT_FOUND", error, readData)
        } else {
            call.reject(error.localizedDescription, "UNREACHABLE", error, readData)
        }
    }
}

extension BabylonSlateScopedStoragePlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPickCall else { return }
        pendingPickCall = nil
        guard let url = urls.first else {
            call.reject("Cancelled", "CANCELLED")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            guard let folder = self.storeFolder(url: url) else {
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

private enum FileTransferFailure: LocalizedError {
    case mismatch(String)
    case cancelled
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .mismatch(let message), .refused(let message): return message
        case .cancelled: return "The transfer was cancelled"
        }
    }
}

/// Streams Git LFS objects between a URL and a file in app storage with
/// URLSession, so their bytes never cross the bridge: uploads with an upload
/// task from the file (URLSession sends its length), downloads with a
/// download task, moved beside the file as `.haptic-<uuid>.tmp`, hashed with
/// CryptoKit in chunks, and renamed over it only when it is the expected
/// object. Headers are the caller's, used once and never kept; the session is
/// ephemeral (no cookies or cache) and follows no redirect, so a 3xx comes
/// back as the status. Progress goes to JavaScript at most every 100 ms.
private final class ProjectFileTransfers: NSObject, URLSessionDownloadDelegate {
    private final class Transfer {
        let call: CAPPluginCall
        let file: URL
        let expected: (size: Int64, sha256: String)?
        var task: URLSessionTask?
        var sent: (bytes: Int64, sha256: String)?
        var staged: URL?
        var failure: Error?
        var cancelled = false
        var lastProgress = Date.distantPast

        init(call: CAPPluginCall, file: URL, expected: (size: Int64, sha256: String)?) {
            self.call = call
            self.file = file
            self.expected = expected
        }
    }

    private static let chunkBytes = 1 << 20
    private weak var plugin: CAPPlugin?
    private let lock = NSLock()
    private var transfers: [String: Transfer] = [:]
    private var ids: [Int: String] = [:]
    private let work = DispatchQueue(label: "BabylonSlate.FileTransfers", qos: .userInitiated)
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    init(plugin: CAPPlugin) {
        self.plugin = plugin
    }

    func start(call: CAPPluginCall, id: String, method: String, url: URL, headers: [String: String], file: URL, expected: (size: Int64, sha256: String)?) {
        let transfer = Transfer(call: call, file: file, expected: expected)
        lock.lock()
        guard transfers[id] == nil else {
            lock.unlock()
            call.reject("A transfer with this id is already running", "UNREACHABLE")
            return
        }
        transfers[id] = transfer
        lock.unlock()
        work.async {
            do {
                var request = URLRequest(url: url)
                request.httpMethod = method
                for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: file.deletingLastPathComponent().path, isDirectory: &isDirectory), isDirectory.boolValue else {
                    throw FileTransferFailure.refused("The file's folder does not exist")
                }
                let task: URLSessionTask
                if method == "PUT" {
                    let sent = try Self.hash(file)
                    if let expected = expected, sent.bytes != expected.size || sent.sha256 != expected.sha256 {
                        throw FileTransferFailure.mismatch("The file is not the object its name says")
                    }
                    transfer.sent = sent
                    task = self.session.uploadTask(with: request, fromFile: file)
                } else {
                    task = self.session.downloadTask(with: request)
                }
                self.lock.lock()
                let cancelled = transfer.cancelled
                if !cancelled {
                    transfer.task = task
                    self.ids[task.taskIdentifier] = id
                }
                self.lock.unlock()
                if cancelled { throw FileTransferFailure.cancelled }
                task.resume()
            } catch {
                self.finish(id: id, error: error)
            }
        }
    }

    func cancel(id: String) {
        lock.lock()
        let transfer = transfers[id]
        transfer?.cancelled = true
        let task = transfer?.task
        lock.unlock()
        task?.cancel()
    }

    // MARK: URLSession delegate

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        progress(task: task, bytes: totalBytesSent)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(task: downloadTask, bytes: totalBytesWritten)
    }

    /// The system removes `location` when this returns, so a 2xx body moves beside its file now.
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let transfer = transfer(for: downloadTask),
              let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, (200...299).contains(status) else { return }
        let staged = transfer.file.deletingLastPathComponent().appendingPathComponent(".haptic-\(UUID().uuidString.lowercased()).tmp")
        do {
            try FileManager.default.moveItem(at: location, to: staged)
            transfer.staged = staged
        } catch {
            transfer.failure = error
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let id = ids.removeValue(forKey: task.taskIdentifier)
        let transfer = id.flatMap { transfers[$0] }
        lock.unlock()
        guard let id = id, let transfer = transfer else { return }
        if let error = error ?? transfer.failure {
            finish(id: id, error: transfer.cancelled ? FileTransferFailure.cancelled : error)
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if let sent = transfer.sent {
            finish(id: id, result: ["status": status, "bytes": sent.bytes, "sha256": sent.sha256])
            return
        }
        guard let staged = transfer.staged else {
            // An error status: nothing was written.
            finish(id: id, result: ["status": status, "bytes": 0, "sha256": ""])
            return
        }
        work.async {
            do {
                let received = try Self.hash(staged)
                if let expected = transfer.expected, received.bytes != expected.size || received.sha256 != expected.sha256 {
                    throw FileTransferFailure.mismatch("The downloaded file arrived damaged")
                }
                if transfer.cancelled { throw FileTransferFailure.cancelled }
                guard Darwin.rename(staged.path, transfer.file.path) == 0 else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
                transfer.staged = nil
                self.progress(transfer: transfer, id: id, bytes: received.bytes, final: true)
                self.finish(id: id, result: ["status": status, "bytes": received.bytes, "sha256": received.sha256])
            } catch {
                self.finish(id: id, error: error)
            }
        }
    }

    // MARK: Helpers

    private func transfer(for task: URLSessionTask) -> Transfer? {
        lock.lock()
        defer { lock.unlock() }
        return ids[task.taskIdentifier].flatMap { transfers[$0] }
    }

    private func progress(task: URLSessionTask, bytes: Int64) {
        lock.lock()
        let id = ids[task.taskIdentifier]
        let transfer = id.flatMap { transfers[$0] }
        lock.unlock()
        guard let id = id, let transfer = transfer else { return }
        progress(transfer: transfer, id: id, bytes: bytes, final: false)
    }

    private func progress(transfer: Transfer, id: String, bytes: Int64, final: Bool) {
        let now = Date()
        guard final || now.timeIntervalSince(transfer.lastProgress) >= 0.1 else { return }
        transfer.lastProgress = now
        plugin?.notifyListeners("transferProgress", data: ["id": id, "bytes": bytes])
    }

    private func finish(id: String, result: [String: Any]) {
        lock.lock()
        let transfer = transfers.removeValue(forKey: id)
        lock.unlock()
        transfer?.call.resolve(result)
    }

    private func finish(id: String, error: Error) {
        lock.lock()
        let transfer = transfers.removeValue(forKey: id)
        lock.unlock()
        guard let transfer = transfer else { return }
        if let staged = transfer.staged { try? FileManager.default.removeItem(at: staged) }
        if let failure = error as? FileTransferFailure {
            switch failure {
            case .mismatch(let message):
                transfer.call.reject(message, "MISMATCH", error)
            case .refused(let message):
                transfer.call.reject(message, "UNREACHABLE", error)
            case .cancelled:
                transfer.call.reject("The transfer was cancelled", "CANCELLED", error)
            }
        } else if (error as? URLError)?.code == .cancelled || transfer.cancelled {
            transfer.call.reject("The transfer was cancelled", "CANCELLED", error)
        } else {
            transfer.call.reject(error.localizedDescription, "NETWORK", error)
        }
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    /// A file's size and SHA-256, read in bounded chunks.
    static func hash(_ url: URL) throws -> (bytes: Int64, sha256: String) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes: Int64 = 0
        while true {
            let chunk = try autoreleasepool { try handle.read(upToCount: chunkBytes) } ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
            bytes += Int64(chunk.count)
        }
        return (bytes, hex(hasher.finalize()))
    }

    /// `size` random bytes in a new file of `folder`, named by their SHA-256.
    static func writeRandomFile(in folder: URL, size: Int64) throws -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw FileTransferFailure.refused("The folder does not exist")
        }
        let staged = folder.appendingPathComponent(".haptic-\(UUID().uuidString.lowercased()).tmp")
        guard FileManager.default.createFile(atPath: staged.path, contents: nil) else {
            throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError)
        }
        var committed = false
        defer { if !committed { try? FileManager.default.removeItem(at: staged) } }
        let handle = try FileHandle(forWritingTo: staged)
        defer { try? handle.close() }
        var hasher = SHA256()
        var remaining = size
        while remaining > 0 {
            let count = Int(min(Int64(chunkBytes), remaining))
            try autoreleasepool {
                var part = Data(count: count)
                let status = part.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
                guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
                hasher.update(data: part)
                try handle.write(contentsOf: part)
            }
            remaining -= Int64(count)
        }
        try handle.synchronize()
        let sha256 = hex(hasher.finalize())
        guard Darwin.rename(staged.path, folder.appendingPathComponent(sha256).path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        committed = true
        return sha256
    }
}
