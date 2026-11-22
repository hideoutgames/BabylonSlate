import Capacitor
import CryptoKit
import Foundation
import Darwin
import Security
import UniformTypeIdentifiers
import WebKit

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

/// The plugin's error code for a failure and the message that goes with it.
private func storageFailure(_ error: Error) -> (code: String, message: String) {
    if let storageError = error as? ScopedStoragePluginError {
        switch storageError {
        case .accessRevoked: return ("ACCESS_REVOKED", storageError.localizedDescription)
        case .stale: return ("STALE", storageError.localizedDescription)
        case .invalidPath: return ("UNREACHABLE", storageError.localizedDescription)
        }
    }
    let nsError = error as NSError
    if nsError.domain == "BabylonSlate.StorageRange" && nsError.code == 2 {
        return ("REVISION_CHANGED", error.localizedDescription)
    }
    if isNotFoundError(error) { return ("NOT_FOUND", "File not found") }
    return ("UNREACHABLE", error.localizedDescription)
}

private func isNotFoundError(_ error: Error) -> Bool {
    let error = error as NSError
    return (error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)) ||
        (error.domain == NSPOSIXErrorDomain && error.code == 2)
}

/// Every storage operation and binary-transport request runs here: never the main thread, never
/// the global pool, and at most four at once.
private enum StorageQueue {
    static let shared: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "BabylonSlate.Storage"
        queue.maxConcurrentOperationCount = 4
        queue.qualityOfService = .userInitiated
        return queue
    }()
}

@objc(BabylonSlateScopedStoragePlugin)
public class BabylonSlateScopedStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateScopedStoragePlugin"
    public let jsName = "BabylonSlateScopedStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBinaryBridgeConfig", returnType: CAPPluginReturnPromise),
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

    /// A chosen folder resolved this session: the bookmark's URL, holding one security-scoped
    /// access, and its root with links resolved once rather than on every operation.
    fileprivate struct ResolvedFolder {
        let url: URL
        let root: URL
    }

    /// A bounded read's parameters, as the plugin call or the binary transport gives them.
    fileprivate struct RangeRequest {
        let offset: Double?
        let length: Double?
        let expectedRevision: String?
    }

    fileprivate struct RangeRead {
        let bytes: Data
        let totalSize: Int64
        let revision: String

        var object: [String: Any] {
            ["data": bytes.base64EncodedString(), "totalSize": totalSize, "revision": revision, "actualBytesRead": bytes.count]
        }
    }

    private var pendingPickCall: CAPPluginCall?
    /// Git LFS objects streamed between a URL and a file in app storage.
    private lazy var fileTransfers = ProjectFileTransfers(plugin: self)
    /// Folders resolved this session, each holding one security-scoped access until `releaseFolder`.
    /// Every bookmark resolution issues a new sandbox extension, and iOS caps
    /// them per process: resolving per file operation exhausted the cap during
    /// one project scaffold, so later folders failed as revoked until relaunch.
    private var resolvedFolders: [String: ResolvedFolder] = [:]
    private let resolvedFoldersLock = NSLock()
    /// One bridge transfer, whole-file or ranged, never exceeds this.
    fileprivate static let maxTransferBytes: Int64 = 512 * 1024 * 1024
    /// App storage roots with links resolved, once per launch.
    private static let documentsRoot = try? FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .resolvingSymlinksInPath().standardizedFileURL
    private static let libraryRoot = try? FileManager.default.url(for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .resolvingSymlinksInPath().standardizedFileURL
    /// App-private data (`libraryRoot` in `documents-adapter.ts`), under Library.
    private static let appDataPath = "Application Support/Haptic"

    override public func load() {
        BinaryStorageBridge.shared.plugin = self
        StorageQueue.shared.addOperation { Self.prepareAppData() }
    }

    /// Library/Application Support is hidden from the Files app and never purged, so recovery
    /// journals survive; excluding it from backup keeps regenerable data out of iCloud.
    private static func prepareAppData() {
        guard let library = libraryRoot else { return }
        var folder = library.appendingPathComponent(appDataPath, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: nil)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try folder.setResourceValues(values)
        } catch {
            NSLog("BabylonSlateScopedStorage: could not prepare app data: %@", error.localizedDescription)
        }
    }

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
        let folder: ResolvedFolder
        do { folder = try resolveFolder(id: id) } catch { reject(call, error: error); return }
        // Opening validates the root once; later reads find a lost root through their failures.
        withCoordinatedRead(folder: folder, path: "", allowRoot: true, materialize: false, execute: { _ -> String in
            try self.validateRoot(folder.url)
            return self.folderName(id: id) ?? folder.url.lastPathComponent
        }) { result in
            switch result {
            case .success(let name): call.resolve(["folder": ["id": id, "name": name]])
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    /// Ends this session's access to a folder; its next operation resolves the bookmark again.
    @objc func releaseFolder(_ call: CAPPluginCall) {
        if let id = call.getString("folder") {
            resolvedFoldersLock.lock()
            let released = resolvedFolders.removeValue(forKey: id)
            resolvedFoldersLock.unlock()
            released?.url.stopAccessingSecurityScopedResource()
        }
        call.resolve()
    }

    /// The binary transport, once the bridge view controller has registered it on the web view.
    @objc func getBinaryBridgeConfig(_ call: CAPPluginCall) {
        let transport = BinaryStorageBridge.shared
        guard transport.isInstalled else {
            call.resolve([:])
            return
        }
        call.resolve(["baseUrl": "\(BinaryStorageBridge.scheme)://\(BinaryStorageBridge.host)", "token": transport.token, "writes": "body"])
    }

    // MARK: - File operations

    @objc func readFileRange(_ call: CAPPluginCall) {
        guard let (folder, path) = folderAndPath(call: call) else { return }
        let range = rangeRequest(call)
        // Ranges need file contents, so an evicted iCloud item is downloaded first.
        withCoordinatedRead(folder: folder, path: path, execute: { target in
            try self.readRange(target: target, range: range)
        }) { result in
            switch result {
            case .success(let read): call.resolve(read.object)
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    @objc func readDocumentsRange(_ call: CAPPluginCall) {
        let range = rangeRequest(call)
        let directory = call.getString("directory") ?? ""
        let path = call.getString("path") ?? ""
        StorageQueue.shared.addOperation {
            do { call.resolve(try self.readAppStorageRange(directory: directory, path: path, range: range).object) } catch { self.reject(call, error: error) }
        }
    }

    private func rangeRequest(_ call: CAPPluginCall) -> RangeRequest {
        RangeRequest(offset: call.getDouble("offset"), length: call.getDouble("length"), expectedRevision: call.getString("expectedRevision"))
    }

    fileprivate func readAppStorageRange(directory: String, path: String, range: RangeRequest) throws -> RangeRead {
        let (root, file) = try appStorageFile(directory: directory, path: path)
        return try coordinatedAppAccess(root: root, target: file, writing: false) { try self.readRange(target: $0, range: range) }
    }

    /// A file in app storage as `documents-adapter.ts` names it: `DOCUMENTS` (or `DATA`) projects
    /// under `BabylonSlate/projects/` in Documents, `LIBRARY` app data under
    /// `Application Support/Haptic/` in Library; inside that folder after resolving links.
    fileprivate func appStorageFile(directory: String, path: String) throws -> (root: URL, file: URL) {
        let base: URL?
        let pathPrefix: String
        switch directory {
        case "DOCUMENTS", "DATA":
            base = Self.documentsRoot
            pathPrefix = "BabylonSlate/projects/"
        case "LIBRARY":
            base = Self.libraryRoot
            pathPrefix = Self.appDataPath + "/"
        default:
            throw ScopedStoragePluginError.invalidPath(path)
        }
        guard let root = base, path.hasPrefix(pathPrefix) else { throw ScopedStoragePluginError.invalidPath(path) }
        return (root, try childURL(root: root, path: path))
    }

    /// App storage is coordinated like chosen folders, so no read sees a write half-done.
    fileprivate func coordinatedAppAccess<T>(root: URL, target: URL, writing: Bool, execute: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        if writing {
            coordinator.coordinate(writingItemAt: target, options: [], error: &coordinationError) { url in
                result = Result<T, Error>(catching: { try execute(self.confinedURL(url, root: root)) })
            }
        } else {
            coordinator.coordinate(readingItemAt: target, options: [], error: &coordinationError) { url in
                result = Result<T, Error>(catching: { try execute(self.confinedURL(url, root: root)) })
            }
        }
        if let error = coordinationError { throw error }
        guard let value = result else { throw NSError(domain: NSCocoaErrorDomain, code: writing ? NSFileWriteUnknownError : NSFileReadUnknownError) }
        return try value.get()
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

    fileprivate func readRange(target: URL, range: RangeRequest) throws -> RangeRead {
        guard let offset = range.offset, let length = range.length,
              offset.isFinite, length.isFinite, offset >= 0, length >= 0,
              offset.rounded(.down) == offset, length.rounded(.down) == length,
              offset + length <= 9007199254740991, length <= Double(Self.maxTransferBytes) else {
            throw rangeFailure("Invalid storage byte range")
        }
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        let (revision, size) = try descriptorRevision(handle.fileDescriptor)
        if let expected = range.expectedRevision, expected != revision {
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
            return RangeRead(bytes: bytes, totalSize: size, revision: revision)
        } catch {
            let failure = error as NSError
            var information = failure.userInfo
            information["actualBytesRead"] = bytes.count
            throw NSError(domain: failure.domain, code: failure.code, userInfo: information)
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let (folder, path) = folderAndPath(call: call) else { return }

        withCoordinatedRead(folder: folder, path: path, execute: { target -> Data in
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
        guard let (folder, path) = folderAndPath(call: call),
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

        withCoordinatedWrite(folder: folder, path: path, execute: { target in
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
            try Self.writeStaged(to: target) { try $0.write(contentsOf: payload) }
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

    /// Writes beside the file as `.haptic-<uuid>.tmp` (the name listings hide), flushes, then
    /// renames it over the file, so a failure or a killed app leaves the previous file intact.
    fileprivate static func writeStaged(to target: URL, write: (FileHandle) throws -> Void) throws {
        let staged = target.deletingLastPathComponent().appendingPathComponent(".haptic-\(UUID().uuidString.lowercased()).tmp")
        guard FileManager.default.createFile(atPath: staged.path, contents: nil) else {
            throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError)
        }
        var committed = false
        defer { if !committed { try? FileManager.default.removeItem(at: staged) } }
        let handle = try FileHandle(forWritingTo: staged)
        do {
            try write(handle)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        guard Darwin.rename(staged.path, target.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        committed = true
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let (folder, path) = folderAndPath(call: call) else { return }
        let recursive = call.getBool("recursive") ?? false

        withCoordinatedWrite(folder: folder, path: path, execute: { target in
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
        guard let (folder, path) = folderAndPath(call: call) else { return }

        withCoordinatedWrite(folder: folder, path: path, options: .forDeleting, execute: { target in
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
        guard let (folder, path) = folderAndPath(call: call) else { return }

        withCoordinatedWrite(folder: folder, path: path, options: .forDeleting, execute: { target in
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

    /// One directory read that returns each entry's type, size and date with it, instead of
    /// two more calls per entry; a symbolic link still reports what it points at.
    @objc func readdir(_ call: CAPPluginCall) {
        guard let (folder, path) = folderAndPath(call: call) else { return }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]

        withCoordinatedRead(folder: folder,
                            path: path,
                            options: .withoutChanges,
                            allowRoot: true,
                            execute: { target in
            let items = try FileManager.default.contentsOfDirectory(at: target, includingPropertiesForKeys: keys, options: [])
            return items.map { item -> [String: Any] in
                let name = item.lastPathComponent
                guard let values = try? item.resourceValues(forKeys: Set(keys)), values.isSymbolicLink != true else {
                    return self.dirEntry(url: item, name: name)
                }
                let isDir = values.isDirectory == true
                var entry: [String: Any] = ["name": name, "isDir": isDir]
                if !isDir {
                    if let size = values.fileSize { entry["size"] = Int64(size) }
                    if let date = values.contentModificationDate { entry["mtime"] = Int64(date.timeIntervalSince1970 * 1000) }
                }
                return entry
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
        guard let (folder, path) = folderAndPath(call: call) else { return }
        withCoordinatedRead(folder: folder, path: path, allowRoot: true, materialize: false, execute: { target in
            try self.itemMetadata(at: target)
        }) { result in
            switch result {
            case .success(let metadata): call.resolve(metadata)
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let (folder, path) = folderAndPath(call: call) else { return }
        withCoordinatedRead(folder: folder, path: path, allowRoot: true, materialize: false, execute: { target in
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
        guard let path = call.getString("path"), path.hasPrefix("BabylonSlate/projects/"),
              path.split(separator: "/").count >= 4,
              ["DOCUMENTS", "DATA"].contains(call.getString("directory") ?? "") else {
            throw ScopedStoragePluginError.invalidPath(call.getString("path") ?? "")
        }
        return try appStorageFile(directory: "DOCUMENTS", path: path).file
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

    private func folderAndPath(call: CAPPluginCall) -> (ResolvedFolder, String)? {
        guard let id = call.getString("folder"), !id.isEmpty else {
            call.reject("folder is required", "NOT_FOUND")
            return nil
        }
        let folder: ResolvedFolder
        do { folder = try resolveFolder(id: id) } catch { reject(call, error: error); return nil }
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return nil
        }
        return (folder, path)
    }

    fileprivate func resolveFolder(id: String) throws -> ResolvedFolder {
        resolvedFoldersLock.lock()
        let cached = resolvedFolders[id]
        resolvedFoldersLock.unlock()
        if let cached = cached { return cached }
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey(id)) else {
            throw ScopedStoragePluginError.stale
        }
        var isStale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data,
                          options: [],
                          relativeTo: nil,
                          bookmarkDataIsStale: &isStale)
        } catch {
            throw ScopedStoragePluginError.stale
        }
        // Held until `releaseFolder`; per-operation start/stop pairs on this URL
        // only adjust its count and issue no new extension.
        guard url.startAccessingSecurityScopedResource() else {
            throw ScopedStoragePluginError.accessRevoked
        }
        if isStale {
            guard let renewed = try? url.bookmarkData(options: [],
                                                       includingResourceValuesForKeys: nil,
                                                       relativeTo: nil) else {
                url.stopAccessingSecurityScopedResource()
                throw ScopedStoragePluginError.stale
            }
            UserDefaults.standard.set(renewed, forKey: bookmarkKey(id))
        }
        let folder = ResolvedFolder(url: url, root: url.resolvingSymlinksInPath().standardizedFileURL)
        resolvedFoldersLock.lock()
        defer { resolvedFoldersLock.unlock() }
        if let existing = resolvedFolders[id] {
            // A concurrent call resolved it first; keep one held access.
            url.stopAccessingSecurityScopedResource()
            return existing
        }
        resolvedFolders[id] = folder
        return folder
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

    /// `root` has its links resolved already (`ResolvedFolder.root`, the app storage roots).
    private func childURL(root: URL, path: String, allowRoot: Bool = false) throws -> URL {
        if path.isEmpty {
            guard allowRoot else { throw ScopedStoragePluginError.invalidPath(path) }
            return root
        }
        guard !path.hasPrefix("/"), !path.hasPrefix("\\") else {
            throw ScopedStoragePluginError.invalidPath(path)
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
              !path.contains("\\"), !path.contains("\0") else {
            throw ScopedStoragePluginError.invalidPath(path)
        }
        return try confinedURL(root.appendingPathComponent(path), root: root, allowRoot: allowRoot)
    }

    /// The target with its links resolved, which must stay inside `root`.
    private func confinedURL(_ url: URL, root: URL, allowRoot: Bool = false) throws -> URL {
        let target = url.resolvingSymlinksInPath().standardizedFileURL
        let rootComponents = root.pathComponents
        let targetComponents = target.pathComponents
        guard (allowRoot ? targetComponents.count >= rootComponents.count : targetComponents.count > rootComponents.count),
              Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
            throw ScopedStoragePluginError.invalidPath(url.lastPathComponent)
        }
        return target
    }

    /// A coordinated read of a chosen folder's file on the calling thread. A failure is checked
    /// against the root, so a lost root reports lost access rather than a missing file.
    fileprivate func coordinatedRead<T>(folder: ResolvedFolder,
                                        path: String,
                                        options: NSFileCoordinator.ReadingOptions = [],
                                        allowRoot: Bool = false,
                                        materialize: Bool = true,
                                        execute: (URL) throws -> T) throws -> T {
        guard folder.url.startAccessingSecurityScopedResource() else {
            throw ScopedStoragePluginError.accessRevoked
        }
        defer { folder.url.stopAccessingSecurityScopedResource() }
        do {
            let url = try childURL(root: folder.root, path: path, allowRoot: allowRoot)
            if materialize { materializeIfUbiquitous(url) }
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            var result: Result<T, Error>?
            coordinator.coordinate(readingItemAt: url, options: options, error: &coordinatorError) { target in
                result = Result<T, Error>(catching: { try execute(self.confinedURL(target, root: folder.root, allowRoot: allowRoot)) })
            }
            if let error = coordinatorError { throw error }
            guard let value = result else { throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError) }
            return try value.get()
        } catch {
            throw classifyRootFailure(error, folderUrl: folder.url)
        }
    }

    /// A coordinated write; the root is checked inside the coordination, so a write never
    /// recreates a removed root through its parent folders.
    fileprivate func coordinatedWrite<T>(folder: ResolvedFolder,
                                         path: String,
                                         options: NSFileCoordinator.WritingOptions = [],
                                         execute: (URL) throws -> T) throws -> T {
        guard folder.url.startAccessingSecurityScopedResource() else {
            throw ScopedStoragePluginError.accessRevoked
        }
        defer { folder.url.stopAccessingSecurityScopedResource() }
        do {
            let url = try childURL(root: folder.root, path: path)
            materializeIfUbiquitous(url)
            let coordinator = NSFileCoordinator(filePresenter: nil)
            var coordinatorError: NSError?
            var result: Result<T, Error>?
            coordinator.coordinate(writingItemAt: url, options: options, error: &coordinatorError) { target in
                result = Result<T, Error>(catching: {
                    try self.validateRoot(folder.url)
                    return try execute(self.confinedURL(target, root: folder.root))
                })
            }
            if let error = coordinatorError { throw error }
            guard let value = result else { throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError) }
            return try value.get()
        } catch {
            throw classifyRootFailure(error, folderUrl: folder.url)
        }
    }

    private func withCoordinatedRead<T>(folder: ResolvedFolder,
                                        path: String,
                                        options: NSFileCoordinator.ReadingOptions = [],
                                        allowRoot: Bool = false,
                                        materialize: Bool = true,
                                        execute: @escaping (URL) throws -> T,
                                        completion: @escaping (Result<T, Error>) -> Void) {
        StorageQueue.shared.addOperation { [weak self] in
            guard let self = self else { return }
            completion(Result<T, Error>(catching: {
                try self.coordinatedRead(folder: folder, path: path, options: options, allowRoot: allowRoot, materialize: materialize, execute: execute)
            }))
        }
    }

    private func withCoordinatedWrite<T>(folder: ResolvedFolder,
                                         path: String,
                                         options: NSFileCoordinator.WritingOptions = [],
                                         execute: @escaping (URL) throws -> T,
                                         completion: @escaping (Result<T, Error>) -> Void) {
        StorageQueue.shared.addOperation { [weak self] in
            guard let self = self else { return }
            completion(Result<T, Error>(catching: {
                try self.coordinatedWrite(folder: folder, path: path, options: options, execute: execute)
            }))
        }
    }

    /// Asks an evicted iCloud item to download; the coordinated access that follows also waits
    /// for it. Polls back off (50 ms, doubling, 5 s in all) on the storage queue, never on a
    /// global-pool thread, and drop the URL's cached resource values each time, which would
    /// otherwise answer the first status for the whole wait.
    private func materializeIfUbiquitous(_ url: URL) {
        guard FileManager.default.isUbiquitousItem(at: url) else { return }
        func isCurrent() -> Bool {
            var probe = url
            probe.removeAllCachedResourceValues()
            return (try? probe.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus == .current
        }
        if isCurrent() { return }
        do {
            try FileManager.default.startDownloadingUbiquitousItem(at: url)
        } catch {
            // Ignore; the read/write will surface the real error if the item is unavailable.
        }
        let deadline = Date(timeIntervalSinceNow: 5)
        var delay: TimeInterval = 0.05
        while deadline.timeIntervalSinceNow > 0 {
            Thread.sleep(forTimeInterval: min(delay, deadline.timeIntervalSinceNow))
            if isCurrent() { return }
            delay *= 2
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
        if error is ScopedStoragePluginError { return error }
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
        isNotFoundError(error)
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
        let failure = storageFailure(error)
        call.reject(failure.message, failure.code, error, readData)
    }
}

/// The app's bridge view controller (Main.storyboard, SceneDelegate): Capacitor's, with the
/// binary storage transport registered on the web view's configuration before the web view
/// exists, beside Capacitor's own `capacitor://` handler, which it leaves alone.
class BabylonSlateBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.setURLSchemeHandler(BinaryStorageSchemeHandler(), forURLScheme: BinaryStorageBridge.scheme)
        BinaryStorageBridge.shared.markInstalled()
        return configuration
    }
}

/// WebKit's entry points for the binary transport; the work and its state live in `BinaryStorageBridge`.
private final class BinaryStorageSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        BinaryStorageBridge.shared.start(urlSchemeTask, request: urlSchemeTask.request)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        BinaryStorageBridge.shared.stop(urlSchemeTask)
    }
}

/// The binary transport's iOS side: an in-process `WKURLSchemeHandler` at
/// `haptic-storage://bridge/<token>/file`. `packages/vfs/src/native-binary-bridge.ts` is the
/// source of these names and headers. GET answers a file (ranged reads in one body, whole files
/// streamed in 1 MiB chunks); POST replaces a file with the raw body, staged and renamed. Only
/// pages in this app's web view can reach the scheme, every request needs this launch's random
/// token, and paths are confined to app storage or a resolved chosen folder exactly as the
/// plugin's own calls are. File work runs on the storage queue; every task call happens on the
/// main thread and never after WebKit stopped the task, which would raise an exception.
private final class BinaryStorageBridge {
    static let shared = BinaryStorageBridge()
    static let scheme = "haptic-storage"
    static let host = "bridge"
    static let revisionHeader = "X-Haptic-Revision"
    static let totalBytesHeader = "X-Haptic-Total-Bytes"
    static let actualBytesHeader = "X-Haptic-Actual-Bytes"
    static let errorHeader = "X-Haptic-Error"
    static let bodyMissing = "BODY_MISSING"
    private static let chunkBytes = 1 << 20

    /// A write whose body WebKit did not deliver whole: the page then writes through the plugin.
    private struct BodyMissing: Error {}

    private enum Body {
        case data(Data)
        case stream(InputStream)
    }

    let token: String = {
        var bytes = [UInt8](repeating: 0, count: 24)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            return UUID().uuidString.lowercased() + UUID().uuidString.lowercased()
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }()
    weak var plugin: BabylonSlateScopedStoragePlugin?
    private(set) var isInstalled = false
    /// Tasks WebKit has started and not stopped.
    private var live = Set<ObjectIdentifier>()
    private let liveLock = NSLock()

    func markInstalled() {
        isInstalled = true
    }

    /// The task is touched only on the main thread; its request is read there by the caller.
    func start(_ task: WKURLSchemeTask, request: URLRequest) {
        let id = ObjectIdentifier(task as AnyObject)
        liveLock.lock()
        live.insert(id)
        liveLock.unlock()
        StorageQueue.shared.addOperation { [weak self] in
            self?.serve(request, task: task, id: id)
        }
    }

    func stop(_ task: WKURLSchemeTask) {
        liveLock.lock()
        live.remove(ObjectIdentifier(task as AnyObject))
        liveLock.unlock()
    }

    private func isLive(_ id: ObjectIdentifier) -> Bool {
        liveLock.lock()
        defer { liveLock.unlock() }
        return live.contains(id)
    }

    /// Runs `body` on the main thread if the task is still live; `finishing` ends it there.
    private func onMain(_ id: ObjectIdentifier, finishing: Bool = false, _ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async {
            self.liveLock.lock()
            let live = finishing ? self.live.remove(id) != nil : self.live.contains(id)
            self.liveLock.unlock()
            if live { body() }
        }
    }

    private static func headers(_ extra: [String: String]) -> [String: String] {
        var headers = [
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Expose-Headers": "\(revisionHeader), \(totalBytesHeader), \(actualBytesHeader), \(errorHeader)",
            "Cache-Control": "no-store",
            "Cross-Origin-Resource-Policy": "cross-origin",
        ]
        headers.merge(extra) { _, given in given }
        return headers
    }

    private func respond(_ task: WKURLSchemeTask, id: ObjectIdentifier, url: URL, status: Int, headers: [String: String], body: Data?) {
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: Self.headers(headers)) else {
            onMain(id, finishing: true) { task.didFailWithError(URLError(.badURL)) }
            return
        }
        onMain(id, finishing: true) {
            task.didReceive(response)
            if let body = body, !body.isEmpty { task.didReceive(body) }
            task.didFinish()
        }
    }

    private func respondFailure(_ task: WKURLSchemeTask, id: ObjectIdentifier, url: URL, error: Error) {
        let failure = error is BodyMissing ? (code: Self.bodyMissing, message: "The request body did not arrive") : storageFailure(error)
        let status: Int
        switch failure.code {
        case "NOT_FOUND": status = 404
        case "REVISION_CHANGED": status = 409
        case "STALE", "ACCESS_REVOKED": status = 403
        case "UNREACHABLE", Self.bodyMissing: status = 400
        default: status = 500
        }
        let actualBytesRead = (error as NSError).userInfo["actualBytesRead"] as? Int ?? 0
        respond(task, id: id, url: url, status: status, headers: [
            "Content-Type": "text/plain; charset=utf-8",
            Self.errorHeader: failure.code,
            Self.actualBytesHeader: String(actualBytesRead),
        ], body: Data(failure.message.utf8))
    }

    private func serve(_ request: URLRequest, task: WKURLSchemeTask, id: ObjectIdentifier) {
        guard let url = request.url else {
            onMain(id, finishing: true) { task.didFailWithError(URLError(.badURL)) }
            return
        }
        guard url.host == Self.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.path == "/\(token)/file" else {
            respondFailure(task, id: id, url: url, error: ScopedStoragePluginError.invalidPath(""))
            return
        }
        let method = request.httpMethod ?? "GET"
        if method == "OPTIONS" {
            respond(task, id: id, url: url, status: 204, headers: [:], body: nil)
            return
        }
        guard let plugin = plugin else {
            respondFailure(task, id: id, url: url, error: NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError))
            return
        }
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] {
            if let value = item.value { query[item.name] = value }
        }
        do {
            switch method {
            case "GET":
                try read(query, plugin: plugin, task: task, id: id, url: url)
            case "POST":
                try write(query, request: request, plugin: plugin)
                respond(task, id: id, url: url, status: 204, headers: [:], body: nil)
            default:
                throw ScopedStoragePluginError.invalidPath(url.path)
            }
        } catch {
            respondFailure(task, id: id, url: url, error: error)
        }
    }

    private func read(_ query: [String: String], plugin: BabylonSlateScopedStoragePlugin, task: WKURLSchemeTask, id: ObjectIdentifier, url: URL) throws {
        let path = query["path"] ?? ""
        if let offset = query["offset"] {
            let range = BabylonSlateScopedStoragePlugin.RangeRequest(offset: Double(offset), length: Double(query["length"] ?? ""), expectedRevision: query["revision"])
            let read: BabylonSlateScopedStoragePlugin.RangeRead
            if let directory = query["directory"] {
                read = try plugin.readAppStorageRange(directory: directory, path: path, range: range)
            } else {
                let folder = try plugin.resolveFolder(id: query["folder"] ?? "")
                read = try plugin.coordinatedRead(folder: folder, path: path) { try plugin.readRange(target: $0, range: range) }
            }
            respond(task, id: id, url: url, status: 200, headers: [
                "Content-Type": "application/octet-stream",
                Self.revisionHeader: read.revision,
                Self.totalBytesHeader: String(read.totalSize),
                Self.actualBytesHeader: String(read.bytes.count),
            ], body: read.bytes)
            return
        }
        if let directory = query["directory"] {
            let (root, file) = try plugin.appStorageFile(directory: directory, path: path)
            try plugin.coordinatedAppAccess(root: root, target: file, writing: false) { try self.stream($0, task: task, id: id, url: url) }
        } else {
            let folder = try plugin.resolveFolder(id: query["folder"] ?? "")
            try plugin.coordinatedRead(folder: folder, path: path) { try self.stream($0, task: task, id: id, url: url) }
        }
    }

    /// Sends a whole file in 1 MiB chunks, read only as WebKit takes them (at most four waiting),
    /// so it is never held here at once. A failure before the answer starts throws; one after it
    /// fails the task.
    private func stream(_ target: URL, task: WKURLSchemeTask, id: ObjectIdentifier, url: URL) throws {
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        var info = Darwin.stat()
        guard Darwin.fstat(handle.fileDescriptor, &info) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard (info.st_mode & S_IFMT) == S_IFREG else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EISDIR)) }
        guard info.st_size <= BabylonSlateScopedStoragePlugin.maxTransferBytes else {
            throw NSError(domain: "BabylonSlate.StorageRange", code: 1, userInfo: [NSLocalizedDescriptionKey: "File is too large to read at once"])
        }
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: Self.headers([
            "Content-Type": "application/octet-stream",
            "Content-Length": String(info.st_size),
            Self.totalBytesHeader: String(info.st_size),
        ])) else { throw URLError(.badURL) }
        onMain(id) { task.didReceive(response) }
        let pending = DispatchSemaphore(value: 4)
        do {
            while true {
                let chunk = try autoreleasepool { try handle.read(upToCount: Self.chunkBytes) } ?? Data()
                if chunk.isEmpty { break }
                pending.wait()
                guard isLive(id) else {
                    pending.signal()
                    return
                }
                DispatchQueue.main.async {
                    defer { pending.signal() }
                    self.liveLock.lock()
                    let live = self.live.contains(id)
                    self.liveLock.unlock()
                    if live { task.didReceive(chunk) }
                }
            }
            onMain(id, finishing: true) { task.didFinish() }
        } catch {
            onMain(id, finishing: true) { task.didFailWithError(error) }
        }
    }

    /// A POST body replaces the file. WebKit hands a body as `httpBody` or `httpBodyStream`; it
    /// must hold exactly `size` bytes, or this web view does not deliver bodies to the handler.
    private func write(_ query: [String: String], request: URLRequest, plugin: BabylonSlateScopedStoragePlugin) throws {
        guard let sizeText = query["size"], let size = Int64(sizeText), size >= 0, size <= BabylonSlateScopedStoragePlugin.maxTransferBytes else {
            throw ScopedStoragePluginError.invalidPath(query["path"] ?? "")
        }
        let body: Body
        if let data = request.httpBody {
            guard Int64(data.count) == size else { throw BodyMissing() }
            body = .data(data)
        } else if let stream = request.httpBodyStream {
            body = .stream(stream)
        } else {
            guard size == 0 else { throw BodyMissing() }
            body = .data(Data())
        }
        let path = query["path"] ?? ""
        let commit: (URL) throws -> Void = { target in
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
            try BabylonSlateScopedStoragePlugin.writeStaged(to: target) { handle in
                switch body {
                case .data(let data):
                    try handle.write(contentsOf: data)
                case .stream(let stream):
                    try Self.copy(stream, to: handle, expected: size)
                }
            }
        }
        if let directory = query["directory"] {
            let (root, file) = try plugin.appStorageFile(directory: directory, path: path)
            try plugin.coordinatedAppAccess(root: root, target: file, writing: true, execute: commit)
        } else {
            let folder = try plugin.resolveFolder(id: query["folder"] ?? "")
            try plugin.coordinatedWrite(folder: folder, path: path, execute: commit)
        }
    }

    private static func copy(_ stream: InputStream, to handle: FileHandle, expected: Int64) throws {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        var copied: Int64 = 0
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? BodyMissing() }
            if count == 0 { break }
            copied += Int64(count)
            guard copied <= expected else { throw BodyMissing() }
            try handle.write(contentsOf: Data(buffer[0..<count]))
        }
        guard copied == expected else { throw BodyMissing() }
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
