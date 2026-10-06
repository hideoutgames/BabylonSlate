import Capacitor
import Foundation
import Darwin
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
        CAPPluginMethod(name: "importBookmark", returnType: CAPPluginReturnPromise),
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
    ]

    private var pendingPickCall: CAPPluginCall?

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
            guard self.pendingPickCall == nil, presenter.presentedViewController == nil else {
                call.reject("A native picker is already open", "UNREACHABLE")
                return
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

    @objc func readFileRange(_ call: CAPPluginCall) {
        guard let (folderUrl, path) = folderAndPath(call: call) else { return }
        withCoordinatedRead(folderUrl: folderUrl, path: path, materialize: false, execute: { target in
            try self.readRange(target: target, call: call)
        }) { result in
            switch result {
            case .success(let value): call.resolve(value)
            case .failure(let error): self.reject(call, error: error)
            }
        }
    }

    @objc func readDocumentsRange(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), path.hasPrefix("BabylonSlate/projects/"),
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

    private func rangeFailure(_ message: String) -> NSError {
        NSError(domain: "BabylonSlate.StorageRange", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
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
              offset + length <= 9007199254740991, length <= 512 * 1024 * 1024 else {
            throw rangeFailure("Invalid storage byte range")
        }
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        let (revision, size) = try descriptorRevision(handle.fileDescriptor)
        if let expected = call.getString("expectedRevision"), expected != revision {
            throw rangeFailure("Source revision changed: \(target.lastPathComponent)")
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
            guard try descriptorRevision(handle.fileDescriptor).0 == revision else { throw rangeFailure("Source revision changed during read") }
            let current = try FileHandle(forReadingFrom: target)
            defer { try? current.close() }
            guard try descriptorRevision(current.fileDescriptor).0 == revision else { throw rangeFailure("Source revision changed during read") }
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
            call.reject("Folder bookmark not found; reconnect required", "STALE")
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
                guard accessing else {
                    call.reject("Folder access has been revoked", "ACCESS_REVOKED")
                    return nil
                }
                defer { url.stopAccessingSecurityScopedResource() }
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
        guard accessing else { return nil }
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }

        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { return nil }
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
                completion(.failure(error))
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
                completion(.failure(error))
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

    private func classifyRootFailure(_ error: Error, folderUrl: URL) -> Error {
        do { try validateRoot(folderUrl) } catch { return error }
        return error
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
        if isNotFound(error) {
            call.reject("File not found", "NOT_FOUND", error, readData)
        } else if (nsError.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(nsError.code)) ||
                    (nsError.domain == NSPOSIXErrorDomain && [1, 13].contains(nsError.code)) {
            call.reject("Folder access has been revoked", "ACCESS_REVOKED", error, readData)
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
