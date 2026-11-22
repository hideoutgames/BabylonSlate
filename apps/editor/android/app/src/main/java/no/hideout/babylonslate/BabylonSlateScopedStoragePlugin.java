package no.hideout.babylonslate;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

@CapacitorPlugin(name = "BabylonSlateScopedStorage")
public class BabylonSlateScopedStoragePlugin extends Plugin {
    private static final String STORE_NAME = "babylonslate-scoped-storage";
    private static final String URI_PREFIX = "uri:";
    private static final String NAME_PREFIX = "name:";
    /** One bridge transfer, whole-file or ranged, never exceeds this. */
    private static final int MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
    private boolean pickPending;
    private boolean readScopeLifecycleAttached;
    private final Map<String, FolderAccess> readScopes = new ConcurrentHashMap<>();
    private final WebViewListener readScopeLifecycle = new WebViewListener() {
        @Override
        public void onPageStarted(WebView view) {
            readScopes.clear();
        }
    };

    /**
     * File operations run here, never on Capacitor's single plugin thread, which every plugin shares:
     * four threads, so reads of one folder run in parallel while a long write or scan blocks no other plugin.
     */
    private static final int IO_THREADS = 4;
    private final ExecutorService ioExecutor = Executors.newFixedThreadPool(IO_THREADS, work -> new Thread(work, "BabylonSlate storage"));
    /** Per chosen folder (tree URI): reads share it, a mutation holds it alone, so no listing outlives a change. */
    private final Map<String, ReentrantReadWriteLock> folderLocks = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // A killed app can leave chunked writes staged for chosen folders; nothing reads them.
        ioExecutor.execute(() -> {
            File[] leftovers = new File(getContext().getCacheDir(), WRITE_STAGING_FOLDER).listFiles();
            if (leftovers != null) for (File leftover : leftovers) leftover.delete();
        });
    }

    @Override
    protected void handleOnStart() {
        // Bridge.Builder replaces its listener list after plugin load().
        if (!readScopeLifecycleAttached) {
            getBridge().addWebViewListener(readScopeLifecycle);
            readScopeLifecycleAttached = true;
        }
        super.handleOnStart();
    }

    private static class PluginFailure extends Exception {
        final String code;
        int actualBytesRead;

        PluginFailure(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private static class FolderAccess {
        final Uri treeUri;
        final Uri rootUri;
        final DirectoryReadCache<DocumentMetadata> directories;

        FolderAccess(Uri treeUri) {
            this(treeUri, false);
        }

        FolderAccess(Uri treeUri, boolean cacheDirectories) {
            this.treeUri = treeUri;
            this.directories = cacheDirectories ? new DirectoryReadCache<>(8192) : null;
            this.rootUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            );
        }
    }

    private static class DocumentMetadata {
        final Uri uri;
        final String name;
        final boolean directory;
        final long size;
        final long modified;

        DocumentMetadata(Uri uri, String name, boolean directory, long size, long modified) {
            this.uri = uri;
            this.name = name;
            this.directory = directory;
            this.size = size;
            this.modified = modified;
        }
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public synchronized void pickFolder(PluginCall call) {
        if (pickPending) {
            call.reject("A native picker is already open", "UNREACHABLE");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        pickPending = true;
        try {
            startActivityForResult(call, intent, "pickFolderResult");
        } catch (RuntimeException error) {
            // No result callback follows a launch that failed, so later picks must not wait for one.
            pickPending = false;
            call.reject("Folder selection is unavailable", "UNREACHABLE", error);
        }
    }

    @ActivityCallback
    private synchronized void pickFolderResult(PluginCall call, ActivityResult result) {
        pickPending = false;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Folder selection cancelled", "CANCELLED");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("Folder selection is unavailable", "UNREACHABLE");
            return;
        }
        execute(() -> {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
                String id = UUID.randomUUID().toString();
                String name = displayName(new FolderAccess(uri).rootUri);
                if (name == null || name.isEmpty()) name = "Project";
                boolean saved = preferences().edit()
                    .putString(URI_PREFIX + id, uri.toString())
                    .putString(NAME_PREFIX + id, name)
                    .commit();
                if (!saved) throw new IllegalStateException("Folder identity write failed");
                call.resolve(folderResult(id, name));
            } catch (SecurityException error) {
                call.reject("Folder access has been revoked", "ACCESS_REVOKED", error);
            } catch (Exception error) {
                call.reject("Folder selection failed", null, error);
            }
        });
    }

    @PluginMethod
    public void openFolder(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("id is required", "NOT_FOUND");
            return;
        }
        String stored = preferences().getString(URI_PREFIX + id, null);
        if (stored == null) {
            call.reject("Project folder is no longer available; reconnect required", "STALE");
            return;
        }
        Uri uri = Uri.parse(stored);
        if (!hasPersistedAccess(uri)) {
            call.reject("Folder access has been revoked", "ACCESS_REVOKED");
            return;
        }
        String name = preferences().getString(NAME_PREFIX + id, "Project");
        call.resolve(folderResult(id, name));
    }

    @PluginMethod
    public void readFileRange(PluginCall call) {
        executeFolderOperation(call, false, folder ->
            call.resolve(rangeObject(readFolderRange(folder, path(call, false), number(call, "offset"), number(call, "length"), call.getString("expectedRevision"))))
        );
    }

    @PluginMethod
    public void readDocumentsRange(PluginCall call) {
        executeFileOperation(call, () -> {
            File target = appStorageFile(call.getString("directory"), call.getString("path"));
            call.resolve(rangeObject(readAppStorageRange(target, number(call, "offset"), number(call, "length"), call.getString("expectedRevision"))));
        });
    }

    /** Bytes of a bounded read with the revision they were read at. */
    private static final class RangeRead {
        final byte[] bytes;
        final long totalSize;
        final String revision;

        RangeRead(byte[] bytes, long totalSize, String revision) {
            this.bytes = bytes;
            this.totalSize = totalSize;
            this.revision = revision;
        }
    }

    private static JSObject rangeObject(RangeRead read) {
        JSObject result = new JSObject();
        result.put("data", Base64.encodeToString(read.bytes, Base64.NO_WRAP));
        result.put("totalSize", read.totalSize);
        result.put("revision", read.revision);
        result.put("actualBytesRead", read.bytes.length);
        return result;
    }

    private static Double number(PluginCall call, String name) {
        Object raw = call.getData().opt(name);
        return raw instanceof Number ? ((Number) raw).doubleValue() : null;
    }

    private RangeRead readFolderRange(FolderAccess folder, String path, Double offset, Double length, String expectedRevision) throws Exception {
        Uri target = resolve(folder, path).uri;
        // A read-scope directory cache is not a snapshot. Fetch live metadata.
        DocumentMetadata before = metadata(target);
        try (ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(target, "r")) {
            if (descriptor == null) throw new FileNotFoundException(target.toString());
            String providerRevision = before.uri + ":" + before.size + ":" + before.modified;
            RangeRead result = readRange(descriptor.getFileDescriptor(), providerRevision, offset, length, expectedRevision);
            try {
                DocumentMetadata after = metadata(target);
                if (!(after.uri + ":" + after.size + ":" + after.modified).equals(providerRevision)) {
                    throw new PluginFailure("Source revision changed during read", "REVISION_CHANGED");
                }
            } catch (Exception error) { throw rangeFailure(error, result.bytes.length); }
            return result;
        }
    }

    private RangeRead readAppStorageRange(File target, Double offset, Double length, String expectedRevision) throws Exception {
        try (FileInputStream input = new FileInputStream(target)) {
            String identity = target.getPath() + ":" + target.lastModified();
            RangeRead result = readRange(input.getFD(), identity, offset, length, expectedRevision);
            try (FileInputStream current = new FileInputStream(target)) {
                String revision = target.getPath() + ":" + target.lastModified() + ":" + descriptorRevision(Os.fstat(current.getFD()));
                if (!revision.equals(result.revision)) throw new PluginFailure("Source revision changed during read", "REVISION_CHANGED");
            } catch (Exception error) { throw rangeFailure(error, result.bytes.length); }
            return result;
        }
    }

    /**
     * A file in app storage as `documents-adapter.ts` names it, in Capacitor's directory for it:
     * `DATA` projects under `Projects/`, `LIBRARY` app data under `Haptic/`; both in
     * filesDir, never outside it after resolving links.
     */
    private File appStorageFile(String directory, String rawPath) throws Exception {
        String prefix = "DATA".equals(directory) ? "Projects/" : "LIBRARY".equals(directory) ? "Haptic/" : null;
        if (prefix == null) throw new PluginFailure("Invalid app storage directory", "UNREACHABLE");
        String path = validatePath(rawPath, false);
        if (!path.startsWith(prefix)) throw new PluginFailure("Invalid app storage path", "UNREACHABLE");
        File root = getContext().getFilesDir().getCanonicalFile();
        File target = new File(root, path).getCanonicalFile();
        if (!target.getPath().startsWith(root.getPath() + File.separator)) throw new PluginFailure("Path escapes project root", "UNREACHABLE");
        return target;
    }

    private String descriptorRevision(StructStat value) {
        String identity = value.st_dev + ":" + value.st_ino + ":" + value.st_size + ":";
        if (Build.VERSION.SDK_INT >= 27) return identity + value.st_mtim.tv_sec + ":" + value.st_mtim.tv_nsec + ":" + value.st_ctim.tv_sec + ":" + value.st_ctim.tv_nsec;
        return identity + value.st_mtime + ":" + value.st_ctime;
    }

    private RangeRead readRange(FileDescriptor descriptor, String identity, Double offsetValue, Double lengthValue, String expected) throws Exception {
        if (offsetValue == null || lengthValue == null || !Double.isFinite(offsetValue) || !Double.isFinite(lengthValue) ||
            offsetValue < 0 || lengthValue < 0 || offsetValue != Math.floor(offsetValue) || lengthValue != Math.floor(lengthValue) ||
            offsetValue + lengthValue > 9007199254740991d || lengthValue > MAX_TRANSFER_BYTES) {
            throw new PluginFailure("Invalid storage byte range", "INVALID_RANGE");
        }
        long offset = offsetValue.longValue();
        int length = lengthValue.intValue();
        StructStat before = Os.fstat(descriptor);
        if (!OsConstants.S_ISREG(before.st_mode)) throw new PluginFailure("Provider does not support bounded file reads", "RANGE_UNSUPPORTED");
        String revision = identity + ":" + descriptorRevision(before);
        if (expected != null && !expected.equals(revision)) throw new PluginFailure("Source revision changed", "REVISION_CHANGED");
        if (offset + length > before.st_size) throw new PluginFailure("Storage byte range exceeds file size", "INVALID_RANGE");
        byte[] bytes = new byte[length];
        int count = 0;
        try {
            while (count < length) {
                int read = Os.pread(descriptor, bytes, count, length - count, offset + count);
                if (read <= 0) throw new PluginFailure("Unexpected end of file", "INVALID_RANGE");
                count += read;
            }
            if (!descriptorRevision(Os.fstat(descriptor)).equals(descriptorRevision(before))) {
                throw new PluginFailure("Source revision changed during read", "REVISION_CHANGED");
            }
            return new RangeRead(bytes, before.st_size, revision);
        } catch (Exception error) {
            throw rangeFailure(error, count);
        }
    }

    private PluginFailure rangeFailure(Exception error, int actualBytesRead) {
        PluginFailure failure = error instanceof PluginFailure ? (PluginFailure) error : new PluginFailure(error.getMessage(), "READ_FAILED");
        failure.actualBytesRead = actualBytesRead;
        return failure;
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        executeFolderOperation(call, false, folder -> {
            String path = path(call, false);
            DocumentMetadata target = resolve(folder, path);
            if (target.size > MAX_TRANSFER_BYTES) throw tooLarge();
            try (InputStream input = getContext().getContentResolver().openInputStream(target.uri)) {
                if (input == null) throw new FileNotFoundException(path);
                byte[] bytes = readAll(input);
                String encoding = call.getString("encoding", "utf8");
                String data = "base64".equals(encoding)
                    ? Base64.encodeToString(bytes, Base64.NO_WRAP)
                    : decodeUtf8(bytes);
                JSObject result = new JSObject();
                result.put("data", data);
                call.resolve(result);
            }
        });
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("folder, path and data are required");
            return;
        }
        final boolean base64 = "base64".equals(call.getString("encoding", "utf8"));
        executeFolderOperation(call, true, folder -> {
            final byte[] payload;
            try {
                // Decoded here, on the storage threads, not on Capacitor's plugin thread.
                payload = base64 ? Base64.decode(data, Base64.DEFAULT) : data.getBytes(StandardCharsets.UTF_8);
            } catch (IllegalArgumentException error) {
                throw new PluginFailure("data is not valid base64", null);
            }
            writeFolderFile(folder, path(call, false), output -> output.write(payload));
            call.resolve();
        });
    }

    /** Bytes for a document, written to the stream a provider opens for it. */
    private interface Payload {
        void writeTo(OutputStream output) throws Exception;
    }

    private static Payload filePayload(File source) {
        return output -> {
            byte[] buffer = new byte[TRANSFER_CHUNK];
            try (FileInputStream input = new FileInputStream(source)) {
                for (int read; (read = input.read(buffer)) != -1; ) output.write(buffer, 0, read);
            }
        };
    }

    /** Creates or replaces a file of a chosen folder, creating its parent folders. Call under the folder's write lock. */
    private void writeFolderFile(FolderAccess folder, String path, Payload payload) throws Exception {
        String[] parts = path.split("/", -1);
        Uri parent = folder.rootUri;
        for (int index = 0; index < parts.length - 1; index++) {
            parent = ensureDirectory(folder, parent, parts[index]);
        }
        String name = parts[parts.length - 1];
        DocumentMetadata existing = findChild(folder, parent, name);
        if (existing != null && existing.directory) throw new PluginFailure("File not found", "NOT_FOUND");
        if (existing == null) {
            Uri created = createChild(folder, parent, "application/octet-stream", name);
            try {
                writeDocument(created, payload);
            } catch (Exception error) {
                deleteQuietly(created);
                throw error;
            }
        } else {
            replaceDocument(folder, parent, existing, name, payload);
        }
    }

    /**
     * SAF has no atomic replace. Stage the payload beside the file first, so a
     * failed write leaves the previous contents intact, then swap names. The
     * staged name is the one listings hide (`staged-write.ts`).
     */
    private void replaceDocument(FolderAccess folder, Uri parent, DocumentMetadata existing, String name, Payload payload)
        throws Exception {
        int swapFlags = DocumentsContract.Document.FLAG_SUPPORTS_DELETE | DocumentsContract.Document.FLAG_SUPPORTS_RENAME;
        if ((documentFlags(existing.uri) & swapFlags) != swapFlags) {
            // A file the provider cannot both delete and rename can only be rewritten in place.
            writeDocument(existing.uri, payload);
            return;
        }
        Uri staged = createChild(folder, parent, "application/octet-stream", ".haptic-" + UUID.randomUUID() + ".tmp");
        try {
            // Only the staged file's own flags say whether it can take the old name.
            if ((documentFlags(staged) & DocumentsContract.Document.FLAG_SUPPORTS_RENAME) == 0) {
                deleteQuietly(staged);
                writeDocument(existing.uri, payload);
                return;
            }
            writeDocument(staged, payload);
            if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), existing.uri)) {
                throw new PluginFailure("Could not replace " + name, null);
            }
        } catch (Exception error) {
            deleteQuietly(staged);
            throw error;
        }
        Uri renamed = DocumentsContract.renameDocument(getContext().getContentResolver(), staged, name);
        if (renamed == null || !name.equals(metadata(renamed).name)) {
            throw new PluginFailure("Saved contents of " + name + " remain in a temporary file", null);
        }
    }

    private void writeDocument(Uri target, Payload payload) throws Exception {
        try (OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
            if (output == null) throw new FileNotFoundException(target.toString());
            payload.writeTo(output);
        }
    }

    private void deleteQuietly(Uri target) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), target);
        } catch (Exception ignored) {
            // The original failure is the one worth reporting.
        }
    }

    private int documentFlags(Uri uri) throws Exception {
        String[] projection = { DocumentsContract.Document.COLUMN_FLAGS };
        try (Cursor cursor = getContext().getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new FileNotFoundException(uri.toString());
            return cursor.isNull(0) ? 0 : cursor.getInt(0);
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        executeFolderOperation(call, true, folder -> {
            String path = path(call, false);
            boolean recursive = call.getBoolean("recursive", false);
            String[] parts = path.split("/", -1);
            Uri parent = folder.rootUri;
            for (int index = 0; index < parts.length; index++) {
                DocumentMetadata existing = findChild(folder, parent, parts[index]);
                if (existing != null) {
                    if (!existing.directory) throw new PluginFailure("Path is not a directory", "NOT_FOUND");
                    parent = existing.uri;
                } else {
                    if (!recursive && index != parts.length - 1) throw new PluginFailure("Parent directory not found", "NOT_FOUND");
                    parent = createChild(
                        folder,
                        parent,
                        DocumentsContract.Document.MIME_TYPE_DIR,
                        parts[index]
                    );
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        delete(call);
    }

    @PluginMethod
    public void rmdir(PluginCall call) {
        delete(call);
    }

    private void delete(PluginCall call) {
        executeFolderOperation(call, true, folder -> {
            String path = path(call, false);
            DocumentMetadata target = resolve(folder, path);
            // The entry was just resolved, so a refused delete is a failure, not a missing file.
            if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), target.uri)) {
                throw new PluginFailure("Could not delete " + path, null);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        executeFolderOperation(call, false, folder -> {
            String path = path(call, true);
            DocumentMetadata target = path.isEmpty() ? metadata(folder.rootUri) : resolve(folder, path);
            if (!target.directory) throw new PluginFailure("Path is not a directory", "NOT_FOUND");
            JSArray entries = new JSArray();
            for (DocumentMetadata child : children(folder, target.uri)) entries.put(metadataObject(child));
            JSObject result = new JSObject();
            result.put("entries", entries);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void stat(PluginCall call) {
        executeFolderOperation(call, false, folder -> {
            String path = path(call, true);
            call.resolve(statObject(path.isEmpty() ? metadata(folder.rootUri) : resolve(folder, path)));
        });
    }

    @PluginMethod
    public void exists(PluginCall call) {
        executeFolderOperation(call, false, folder -> {
            String path = path(call, true);
            JSObject result = new JSObject();
            try {
                DocumentMetadata target = path.isEmpty() ? metadata(folder.rootUri) : resolve(folder, path);
                result.put("exists", true);
                result.put("isDirectory", target.directory);
            } catch (PluginFailure error) {
                if (!"NOT_FOUND".equals(error.code)) throw error;
                result.put("exists", false);
                result.put("isDirectory", false);
            }
            call.resolve(result);
        });
    }

    private interface FileOperation {
        void run() throws Exception;
    }

    private interface FolderOperation {
        void run(FolderAccess folder) throws Exception;
    }

    private void invalidateReadScopes() {
        for (FolderAccess folder : readScopes.values()) folder.directories.clear();
    }

    /** Runs on the storage threads and rejects the call with the failure's code. */
    private void executeFileOperation(PluginCall call, FileOperation operation) {
        try {
            ioExecutor.execute(() -> {
                try {
                    operation.run();
                } catch (Exception error) {
                    reject(call, error);
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject("Storage is unavailable", "UNREACHABLE", error);
        }
    }

    /** An operation on the call's chosen folder: reads (which may use a read scope) share its lock, a mutation holds it alone. */
    private void executeFolderOperation(PluginCall call, boolean mutation, FolderOperation operation) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call.getString("folder"), call.getString("readScope"), !mutation);
            underFolderLock(folder, mutation, () -> {
                operation.run(folder);
                return null;
            });
        });
    }

    /** A mutation also clears read-scope listings before and after, so no directory query publishes an old listing. */
    private <T> T underFolderLock(FolderAccess folder, boolean mutation, Callable<T> operation) throws Exception {
        ReentrantReadWriteLock lock = folderLocks.computeIfAbsent(folder.treeUri.toString(), key -> new ReentrantReadWriteLock());
        Lock held = mutation ? lock.writeLock() : lock.readLock();
        held.lock();
        try {
            if (mutation) invalidateReadScopes();
            return operation.call();
        } finally {
            if (mutation) invalidateReadScopes();
            held.unlock();
        }
    }

    private static void reject(PluginCall call, Exception error) {
        if (error instanceof PluginFailure) {
            PluginFailure failure = (PluginFailure) error;
            JSObject data = new JSObject();
            data.put("actualBytesRead", failure.actualBytesRead);
            call.reject(failure.getMessage(), failure.code, failure, data);
        } else if (error instanceof SecurityException) {
            call.reject("Folder access has been revoked", "ACCESS_REVOKED", error);
        } else if (error instanceof FileNotFoundException) {
            call.reject("File not found", "NOT_FOUND", error);
        } else {
            call.reject(error.getMessage() == null ? "Scoped storage operation failed" : error.getMessage(), null, error);
        }
    }

    @PluginMethod
    public void beginReadScope(PluginCall call) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call.getString("folder"), null, false);
            String id = UUID.randomUUID().toString();
            synchronized (readScopes) {
                if (readScopes.size() >= 8) throw new PluginFailure("Too many folder scans", "UNREACHABLE");
                readScopes.put(id, new FolderAccess(folder.treeUri, true));
            }
            JSObject result = new JSObject();
            result.put("readScope", id);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void endReadScope(PluginCall call) {
        String id = call.getString("readScope");
        if (id != null) readScopes.remove(id);
        call.resolve();
    }

    /** Android keeps a chosen folder's persisted permission for its next opening; this session holds nothing more. */
    @PluginMethod
    public void releaseFolder(PluginCall call) {
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        getBridge().removeWebViewListener(readScopeLifecycle);
        readScopeLifecycleAttached = false;
        readScopes.clear();
        // Disconnecting does network I/O, which the main thread (where this runs) may not.
        transferExecutor.execute(() -> {
            for (Transfer transfer : transfers.values()) transfer.cancel();
        });
        // Queued operations still finish; staged writes nobody can commit any more are removed.
        ioExecutor.execute(() -> {
            for (String id : writes.keySet()) discardWrite(id);
        });
        ioExecutor.shutdown();
        super.handleOnDestroy();
    }

    // Binary transport (`packages/vfs/src/native-binary-bridge.ts`, the source of these names): the web
    // view fetches file bytes from this plugin through `shouldInterceptRequest`, and writes them in
    // chunks, since Android WebView never exposes a request's body.

    static final String BINARY_PATH = "/_haptic_storage";
    static final String BINARY_REVISION_HEADER = "X-Haptic-Revision";
    static final String BINARY_TOTAL_BYTES_HEADER = "X-Haptic-Total-Bytes";
    static final String BINARY_ACTUAL_BYTES_HEADER = "X-Haptic-Actual-Bytes";
    static final String BINARY_ERROR_HEADER = "X-Haptic-Error";
    /** Random per launch; only the page that asks `getBinaryBridgeConfig` learns it. */
    private final String bridgeToken = randomToken();
    private volatile boolean storageRequestsInstalled;

    private static String randomToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return hex(bytes);
    }

    /**
     * Serves the binary transport from the WebView's own request hooks, in front of Capacitor's: the
     * page's fetches go to the WebView client, and those the editor's service worker repeats go to
     * the service-worker client, so both answer storage requests and pass everything else to
     * Capacitor's local server as before. Called from `MainActivity` once the bridge exists.
     */
    static void installStorageRequests(Bridge bridge) {
        PluginHandle handle = bridge.getPlugin("BabylonSlateScopedStorage");
        if (handle == null || !(handle.getInstance() instanceof BabylonSlateScopedStoragePlugin)) return;
        final BabylonSlateScopedStoragePlugin plugin = (BabylonSlateScopedStoragePlugin) handle.getInstance();
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse storage = plugin.interceptStorageRequest(request);
                return storage != null ? storage : super.shouldInterceptRequest(view, request);
            }
        });
        final boolean resolveServiceWorker = bridge.getConfig().isResolveServiceWorkerRequests();
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                WebResourceResponse storage = plugin.interceptStorageRequest(request);
                if (storage != null) return storage;
                return resolveServiceWorker ? bridge.getLocalServer().shouldInterceptRequest(request) : null;
            }
        });
        plugin.storageRequestsInstalled = true;
    }

    @PluginMethod
    public void getBinaryBridgeConfig(PluginCall call) {
        JSObject result = new JSObject();
        if (storageRequestsInstalled) {
            result.put("baseUrl", getBridge().getLocalUrl() + BINARY_PATH);
            result.put("token", bridgeToken);
            result.put("writes", "chunks");
        }
        call.resolve(result);
    }

    /** The answer to a binary-transport request, or null for any other URL. Runs on a WebView thread. */
    WebResourceResponse interceptStorageRequest(WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path == null || !path.startsWith(BINARY_PATH + "/")) return null;
        Uri local = Uri.parse(getBridge().getLocalUrl());
        if (!String.valueOf(local.getHost()).equals(url.getHost()) || !String.valueOf(local.getScheme()).equals(url.getScheme())) return null;
        String expected = BINARY_PATH + "/" + bridgeToken + "/file";
        if (!MessageDigest.isEqual(path.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))) {
            return bridgeFailure(new PluginFailure("Refused", "UNREACHABLE"));
        }
        if ("OPTIONS".equals(request.getMethod())) return bridgeAnswer(204, "No Content", bridgeHeaders(), null, null);
        if (!"GET".equals(request.getMethod())) return bridgeFailure(new PluginFailure("Writes go through beginWrite", "UNREACHABLE"));
        try {
            String filePath = url.getQueryParameter("path");
            String offset = url.getQueryParameter("offset");
            String directory = url.getQueryParameter("directory");
            if (offset != null) {
                Double start = parseNumber(offset);
                Double length = parseNumber(url.getQueryParameter("length"));
                String revision = url.getQueryParameter("revision");
                RangeRead read;
                if (directory != null) {
                    read = readAppStorageRange(appStorageFile(directory, filePath), start, length, revision);
                } else {
                    FolderAccess folder = folder(url.getQueryParameter("folder"), url.getQueryParameter("readScope"), true);
                    String confined = validatePath(filePath, false);
                    read = underFolderLock(folder, false, () -> readFolderRange(folder, confined, start, length, revision));
                }
                Map<String, String> headers = bridgeHeaders();
                headers.put(BINARY_REVISION_HEADER, read.revision);
                headers.put(BINARY_TOTAL_BYTES_HEADER, String.valueOf(read.totalSize));
                headers.put(BINARY_ACTUAL_BYTES_HEADER, String.valueOf(read.bytes.length));
                return bridgeAnswer(200, "OK", headers, new ByteArrayInputStream(read.bytes), "application/octet-stream");
            }
            // A whole file streams from its descriptor; its bytes are never held here at once.
            InputStream input;
            Map<String, String> headers = bridgeHeaders();
            if (directory != null) {
                File target = appStorageFile(directory, filePath);
                FileInputStream file = new FileInputStream(target);
                long size = Os.fstat(file.getFD()).st_size;
                if (size > MAX_TRANSFER_BYTES) {
                    file.close();
                    throw tooLarge();
                }
                headers.put("Content-Length", String.valueOf(size));
                input = file;
            } else {
                FolderAccess folder = folder(url.getQueryParameter("folder"), url.getQueryParameter("readScope"), true);
                String confined = validatePath(filePath, false);
                input = underFolderLock(folder, false, () -> {
                    DocumentMetadata target = resolve(folder, confined);
                    if (target.directory) throw new PluginFailure("File not found", "NOT_FOUND");
                    if (target.size > MAX_TRANSFER_BYTES) throw tooLarge();
                    InputStream opened = getContext().getContentResolver().openInputStream(target.uri);
                    if (opened == null) throw new FileNotFoundException(confined);
                    return opened;
                });
            }
            return bridgeAnswer(200, "OK", headers, input, "application/octet-stream");
        } catch (Exception error) {
            return bridgeFailure(error);
        }
    }

    private static Double parseNumber(String value) {
        if (value == null) return null;
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    /** No caching; readable cross-origin (a dev server page) and under the service worker's isolation headers. */
    private static Map<String, String> bridgeHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Expose-Headers",
            BINARY_REVISION_HEADER + ", " + BINARY_TOTAL_BYTES_HEADER + ", " + BINARY_ACTUAL_BYTES_HEADER + ", " + BINARY_ERROR_HEADER);
        headers.put("Cross-Origin-Resource-Policy", "cross-origin");
        return headers;
    }

    private static WebResourceResponse bridgeAnswer(int status, String reason, Map<String, String> headers, InputStream body, String mimeType) {
        return new WebResourceResponse(mimeType == null ? "text/plain" : mimeType, mimeType == null ? "utf-8" : null, status, reason, headers, body);
    }

    private static WebResourceResponse bridgeFailure(Exception error) {
        String code;
        int actualBytesRead = 0;
        String message;
        if (error instanceof PluginFailure) {
            code = ((PluginFailure) error).code;
            actualBytesRead = ((PluginFailure) error).actualBytesRead;
            message = error.getMessage();
        } else if (error instanceof SecurityException) {
            code = "ACCESS_REVOKED";
            message = "Folder access has been revoked";
        } else if (error instanceof FileNotFoundException) {
            code = "NOT_FOUND";
            message = "File not found";
        } else {
            code = null;
            message = error.getMessage();
        }
        int status;
        String reason;
        if ("NOT_FOUND".equals(code)) {
            status = 404;
            reason = "Not Found";
        } else if ("REVISION_CHANGED".equals(code)) {
            status = 409;
            reason = "Conflict";
        } else if ("STALE".equals(code) || "ACCESS_REVOKED".equals(code)) {
            status = 403;
            reason = "Forbidden";
        } else if ("UNREACHABLE".equals(code) || "INVALID_RANGE".equals(code) || "RANGE_UNSUPPORTED".equals(code)) {
            status = 400;
            reason = "Bad Request";
        } else {
            status = 500;
            reason = "Internal Server Error";
        }
        Map<String, String> headers = bridgeHeaders();
        if (code != null) headers.put(BINARY_ERROR_HEADER, code);
        headers.put(BINARY_ACTUAL_BYTES_HEADER, String.valueOf(actualBytesRead));
        byte[] body = (message == null ? "Storage request failed" : message).getBytes(StandardCharsets.UTF_8);
        return bridgeAnswer(status, reason, headers, new ByteArrayInputStream(body), null);
    }

    // Chunked writes: base64 chunks decoded on the storage threads into a staged file, which replaces
    // the target only on commit. App storage stages beside the file and renames it over it (atomic);
    // a chosen folder stages in the app's cache, then replaces the document as `writeFile` does, the
    // best SAF allows (it has no atomic replace). Sessions idle for two minutes are aborted.

    private static final String WRITE_STAGING_FOLDER = "haptic-writes";
    private static final int MAX_WRITES = 16;
    private static final long WRITE_IDLE_NANOS = 120_000_000_000L;

    private static final class WriteSession {
        final File staged;
        /** App storage target, renamed over on commit; null for a chosen folder. */
        final File target;
        final String folderId;
        final String path;
        FileOutputStream output;
        long written;
        volatile long touched = System.nanoTime();

        WriteSession(File staged, File target, String folderId, String path) {
            this.staged = staged;
            this.target = target;
            this.folderId = folderId;
            this.path = path;
        }
    }

    private final Map<String, WriteSession> writes = new ConcurrentHashMap<>();

    @PluginMethod
    public void beginWrite(PluginCall call) {
        executeFileOperation(call, () -> {
            long now = System.nanoTime();
            for (Map.Entry<String, WriteSession> entry : writes.entrySet()) {
                if (now - entry.getValue().touched > WRITE_IDLE_NANOS) discardWrite(entry.getKey());
            }
            if (writes.size() >= MAX_WRITES) throw new PluginFailure("Too many writes in progress", "UNREACHABLE");
            String directory = call.getString("directory");
            WriteSession session;
            if (directory != null) {
                File target = appStorageFile(directory, call.getString("path"));
                File parent = target.getParentFile();
                if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new PluginFailure("Could not create the file's folder", "UNREACHABLE");
                if (target.isDirectory()) throw new PluginFailure("File not found", "NOT_FOUND");
                session = new WriteSession(new File(parent, ".haptic-" + UUID.randomUUID() + ".tmp"), target, null, null);
            } else {
                String folderId = call.getString("folder");
                folder(folderId, null, false);
                String path = validatePath(call.getString("path"), false);
                File staging = new File(getContext().getCacheDir(), WRITE_STAGING_FOLDER);
                if (!staging.isDirectory() && !staging.mkdirs()) throw new PluginFailure("Could not stage the write", "UNREACHABLE");
                session = new WriteSession(new File(staging, UUID.randomUUID() + ".tmp"), null, folderId, path);
            }
            session.output = new FileOutputStream(session.staged);
            String id = UUID.randomUUID().toString();
            writes.put(id, session);
            JSObject result = new JSObject();
            result.put("writeId", id);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void appendWriteChunk(PluginCall call) {
        executeFileOperation(call, () -> {
            String id = call.getString("writeId", "");
            WriteSession session = writes.get(id);
            if (session == null) throw new PluginFailure("The write is no longer open", "UNREACHABLE");
            try {
                append(session, call.getString("data"));
            } catch (Exception error) {
                discardWrite(id);
                throw error;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void commitWrite(PluginCall call) {
        executeFileOperation(call, () -> {
            WriteSession session = writes.remove(call.getString("writeId", ""));
            if (session == null) throw new PluginFailure("The write is no longer open", "UNREACHABLE");
            try {
                Double size = number(call, "size");
                synchronized (session) {
                    append(session, call.getString("data"));
                    if (size == null || session.written != size) throw new PluginFailure("The write arrived incomplete", "UNREACHABLE");
                    session.output.getFD().sync();
                    session.output.close();
                    session.output = null;
                }
                if (session.target != null) {
                    if (!session.staged.renameTo(session.target)) throw new PluginFailure("Could not move the file into place", "UNREACHABLE");
                } else {
                    FolderAccess folder = folder(session.folderId, null, false);
                    underFolderLock(folder, true, () -> {
                        writeFolderFile(folder, session.path, filePayload(session.staged));
                        return null;
                    });
                }
                call.resolve();
            } finally {
                close(session);
                session.staged.delete();
            }
        });
    }

    @PluginMethod
    public void abortWrite(PluginCall call) {
        executeFileOperation(call, () -> {
            discardWrite(call.getString("writeId", ""));
            call.resolve();
        });
    }

    private void discardWrite(String id) {
        WriteSession session = writes.remove(id);
        if (session == null) return;
        close(session);
        session.staged.delete();
    }

    private static void append(WriteSession session, String data) throws Exception {
        if (data == null) throw new PluginFailure("data is required", "UNREACHABLE");
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new PluginFailure("data is not valid base64", "UNREACHABLE");
        }
        synchronized (session) {
            if (session.output == null) throw new PluginFailure("The write is no longer open", "UNREACHABLE");
            if (session.written + bytes.length > MAX_TRANSFER_BYTES) throw tooLarge();
            session.output.write(bytes);
            session.written += bytes.length;
            session.touched = System.nanoTime();
        }
    }

    private static void close(WriteSession session) {
        synchronized (session) {
            if (session.output == null) return;
            try {
                session.output.close();
            } catch (IOException ignored) {
                // The staged file is removed next; nothing was committed.
            }
            session.output = null;
        }
    }

    // Git LFS objects streamed between a URL and a file in app storage, so their bytes never cross the bridge.

    /** One running transfer; `cancel` disconnects it from any thread, which fails its blocked I/O. */
    private static final class Transfer {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        long lastProgress;

        void cancel() {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
        }
    }

    /** A thread of `transferExecutor`, which `TransferCookieGate` tells apart. */
    private static final class TransferThread extends Thread {
        TransferThread(Runnable work) {
            super(work, "BabylonSlate file transfer");
        }
    }

    /**
     * Capacitor makes its WebView cookie store the process's default cookie handler
     * (`CapacitorCookies.load`), which `HttpURLConnection` applies to every request: it adds stored
     * cookies and keeps any `Set-Cookie`. Transfers send and keep no cookie, as on iOS and the desktop,
     * so this wrapper does nothing on a transfer thread and passes everything else through unchanged
     * (sign-in and Git requests share the default). Installed before each connection, since Capacitor
     * may install its handler again.
     */
    private static final class TransferCookieGate extends CookieHandler {
        private final CookieHandler delegate;

        private TransferCookieGate(CookieHandler delegate) {
            this.delegate = delegate;
        }

        static synchronized void install() {
            CookieHandler current = CookieHandler.getDefault();
            if (!(current instanceof TransferCookieGate)) CookieHandler.setDefault(new TransferCookieGate(current));
        }

        private boolean passes() {
            return delegate != null && !(Thread.currentThread() instanceof TransferThread);
        }

        @Override
        public Map<String, List<String>> get(URI uri, Map<String, List<String>> requestHeaders) throws IOException {
            return passes() ? delegate.get(uri, requestHeaders) : Collections.emptyMap();
        }

        @Override
        public void put(URI uri, Map<String, List<String>> responseHeaders) throws IOException {
            if (passes()) delegate.put(uri, responseHeaders);
        }
    }

    /**
     * Transfers run on their own threads: never Capacitor's task thread, which every plugin shares,
     * and never under the read-scope lock `executeFileOperation` holds for the whole operation.
     */
    private final ExecutorService transferExecutor = Executors.newCachedThreadPool(TransferThread::new);
    private final Map<String, Transfer> transfers = new ConcurrentHashMap<>();
    private static final int TRANSFER_CHUNK = 1024 * 1024;
    private static final long PROGRESS_INTERVAL_NANOS = 100_000_000L;

    /**
     * A file of a project in app storage (Capacitor Directory.Data), named as `readDocumentsRange`
     * names one: never a chosen folder (Integrated mode never runs in one), never the project
     * folder itself, inside filesDir after resolving links.
     */
    private File documentsFile(PluginCall call) throws Exception {
        if (!"DATA".equals(call.getString("directory"))) throw new PluginFailure("Invalid Documents directory", "UNREACHABLE");
        String path = path(call, false);
        if (!path.startsWith("Projects/") || path.split("/").length < 4) throw new PluginFailure("Invalid Documents path", "UNREACHABLE");
        File root = getContext().getFilesDir().getCanonicalFile();
        File target = new File(root, path).getCanonicalFile();
        if (!target.getPath().startsWith(root.getPath() + File.separator)) throw new PluginFailure("Path escapes project root", "UNREACHABLE");
        return target;
    }

    @PluginMethod
    public void transferFile(PluginCall call) {
        final String id = call.getString("id");
        final String method = call.getString("method");
        final File file;
        final URL url;
        final Map<String, String> headers = new HashMap<>();
        final Long expectedSize;
        final String expectedSha256;
        try {
            file = documentsFile(call);
            if (id == null || id.isEmpty() || !("GET".equals(method) || "PUT".equals(method))) throw new PluginFailure("Invalid transfer request", "UNREACHABLE");
            url = new URL(call.getString("url", ""));
            if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null) throw new PluginFailure("Files are transferred over HTTPS only", "UNREACHABLE");
            JSObject given = call.getObject("headers", new JSObject());
            for (Iterator<String> names = given.keys(); names.hasNext(); ) {
                String name = names.next();
                Object value = given.opt(name);
                if (!(value instanceof String)) throw new PluginFailure("Header values must be text", "UNREACHABLE");
                headers.put(name, (String) value);
            }
            Object rawSize = call.getData().opt("expectedSize");
            if (rawSize instanceof Number) {
                double size = ((Number) rawSize).doubleValue();
                String sha256 = call.getString("expectedSha256");
                if (size < 0 || size != Math.floor(size) || size > 9007199254740991d || sha256 == null || sha256.length() != 64) {
                    throw new PluginFailure("Invalid expected object", "UNREACHABLE");
                }
                expectedSize = (long) size;
                expectedSha256 = sha256;
            } else {
                expectedSize = null;
                expectedSha256 = null;
            }
        } catch (PluginFailure failure) {
            call.reject(failure.getMessage(), failure.code);
            return;
        } catch (Exception error) {
            call.reject("Invalid transfer request", "UNREACHABLE", error);
            return;
        }
        final Transfer transfer = new Transfer();
        if (transfers.putIfAbsent(id, transfer) != null) {
            call.reject("A transfer with this id is already running", "UNREACHABLE");
            return;
        }
        transferExecutor.execute(() -> {
            try {
                call.resolve("PUT".equals(method)
                    ? upload(id, transfer, url, headers, file, expectedSize, expectedSha256)
                    : download(id, transfer, url, headers, file, expectedSize, expectedSha256));
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage(), transfer.cancelled ? "CANCELLED" : failure.code);
            } catch (Exception error) {
                if (transfer.cancelled) call.reject("The transfer was cancelled", "CANCELLED", error);
                else call.reject(error.getMessage() == null ? "The transfer failed" : error.getMessage(), "NETWORK", error);
            } finally {
                transfers.remove(id);
            }
        });
    }

    @PluginMethod
    public void cancelTransfer(PluginCall call) {
        Transfer transfer = transfers.get(call.getString("id", ""));
        if (transfer != null) {
            // Marked now, so a transfer about to connect stops; disconnecting does network I/O, which
            // Capacitor's shared plugin thread (where this runs) must not wait on.
            transfer.cancelled = true;
            transferExecutor.execute(transfer::cancel);
        }
        call.resolve();
    }

    /** The Git benchmark's objects: random bytes made and hashed here, so no object is built in JavaScript. */
    @PluginMethod
    public void writeRandomObject(PluginCall call) {
        final File folder;
        final long size;
        try {
            folder = documentsFile(call);
            Object raw = call.getData().opt("size");
            double value = raw instanceof Number ? ((Number) raw).doubleValue() : -1;
            if (value < 0 || value != Math.floor(value) || value > 9007199254740991d) throw new PluginFailure("Invalid size", "UNREACHABLE");
            size = (long) value;
        } catch (PluginFailure failure) {
            call.reject(failure.getMessage(), failure.code);
            return;
        } catch (Exception error) {
            call.reject("Invalid request", "UNREACHABLE", error);
            return;
        }
        transferExecutor.execute(() -> {
            File staged = new File(folder, ".haptic-" + UUID.randomUUID() + ".tmp");
            boolean committed = false;
            try {
                if (!folder.isDirectory()) throw new PluginFailure("The folder does not exist", "UNREACHABLE");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[(int) Math.min(TRANSFER_CHUNK, Math.max(1, size))];
                try (FileOutputStream output = new FileOutputStream(staged)) {
                    for (long remaining = size; remaining > 0; ) {
                        int count = (int) Math.min(buffer.length, remaining);
                        ThreadLocalRandom.current().nextBytes(buffer);
                        digest.update(buffer, 0, count);
                        output.write(buffer, 0, count);
                        remaining -= count;
                    }
                    output.getFD().sync();
                }
                String sha256 = hex(digest.digest());
                if (!staged.renameTo(new File(folder, sha256))) throw new PluginFailure("Could not move the object into place", "UNREACHABLE");
                committed = true;
                JSObject result = new JSObject();
                result.put("sha256", sha256);
                call.resolve(result);
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage(), failure.code);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Could not write the object" : error.getMessage(), "UNREACHABLE", error);
            } finally {
                if (!committed) staged.delete();
            }
        });
    }

    /** Never follows a redirect (a 3xx comes back as the status), no cache or cookie; the caller's headers, used once. */
    private HttpURLConnection connect(Transfer transfer, URL url, String method, Map<String, String> headers) throws Exception {
        TransferCookieGate.install();
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(60_000);
        connection.setRequestMethod(method);
        for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
        transfer.connection = connection;
        if (transfer.cancelled) {
            connection.disconnect();
            throw new PluginFailure("The transfer was cancelled", "CANCELLED");
        }
        return connection;
    }

    /** Sends the file with its length (fixed-length streaming: no chunked framing, no buffering), only when it is the expected object. */
    private JSObject upload(String id, Transfer transfer, URL url, Map<String, String> headers, File file, Long expectedSize, String expectedSha256) throws Exception {
        if (!file.isFile()) throw new FileNotFoundException(file.getName());
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[TRANSFER_CHUNK];
        long size = 0;
        try (FileInputStream input = new FileInputStream(file)) {
            for (int read; (read = input.read(buffer)) != -1; ) {
                digest.update(buffer, 0, read);
                size += read;
            }
        }
        String sha256 = hex(digest.digest());
        if (expectedSize != null && (size != expectedSize || !sha256.equals(expectedSha256))) {
            throw new PluginFailure("The file is not the object its name says", "MISMATCH");
        }
        HttpURLConnection connection = connect(transfer, url, "PUT", headers);
        try {
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(size);
            long sent = 0;
            try (FileInputStream input = new FileInputStream(file); OutputStream output = connection.getOutputStream()) {
                for (int read; (read = input.read(buffer)) != -1; ) {
                    output.write(buffer, 0, read);
                    sent += read;
                    progress(id, transfer, sent, false);
                }
            }
            int status = connection.getResponseCode();
            progress(id, transfer, sent, true);
            return transferResult(status, size, sha256);
        } finally {
            connection.disconnect();
        }
    }

    /** Streams the body beside the file, hashing it, and renames it over the file only when it is the expected object. */
    private JSObject download(String id, Transfer transfer, URL url, Map<String, String> headers, File file, Long expectedSize, String expectedSha256) throws Exception {
        File folder = file.getParentFile();
        if (folder == null || !folder.isDirectory()) throw new PluginFailure("The file's folder does not exist", "UNREACHABLE");
        HttpURLConnection connection = connect(transfer, url, "GET", headers);
        File staged = new File(folder, ".haptic-" + UUID.randomUUID() + ".tmp");
        boolean committed = false;
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status > 299) return transferResult(status, 0, "");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[TRANSFER_CHUNK];
            long received = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(staged)) {
                for (int read; (read = input.read(buffer)) != -1; ) {
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                    received += read;
                    progress(id, transfer, received, false);
                }
                output.getFD().sync();
            }
            String sha256 = hex(digest.digest());
            if (expectedSize != null && (received != expectedSize || !sha256.equals(expectedSha256))) {
                throw new PluginFailure("The downloaded file arrived damaged", "MISMATCH");
            }
            if (transfer.cancelled) throw new PluginFailure("The transfer was cancelled", "CANCELLED");
            if (!staged.renameTo(file)) throw new PluginFailure("Could not move the download into place", "UNREACHABLE");
            committed = true;
            progress(id, transfer, received, true);
            return transferResult(status, received, sha256);
        } finally {
            if (!committed) staged.delete();
            connection.disconnect();
        }
    }

    private void progress(String id, Transfer transfer, long bytes, boolean last) {
        long now = System.nanoTime();
        if (!last && now - transfer.lastProgress < PROGRESS_INTERVAL_NANOS) return;
        transfer.lastProgress = now;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("bytes", bytes);
        notifyListeners("transferProgress", event);
    }

    private static JSObject transferResult(int status, long bytes, String sha256) {
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("bytes", bytes);
        result.put("sha256", sha256);
        return result;
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) text.append(Character.forDigit((value >> 4) & 0xf, 16)).append(Character.forDigit(value & 0xf, 16));
        return text.toString();
    }

    /** A chosen folder by id, or its open read scope `scopeId` when given (reads only). */
    private FolderAccess folder(String id, String scopeId, boolean allowReadScope) throws PluginFailure {
        if (id == null || id.isEmpty()) throw new PluginFailure("folder is required", "NOT_FOUND");
        String stored = preferences().getString(URI_PREFIX + id, null);
        if (stored == null) throw new PluginFailure("Project folder is no longer available; reconnect required", "STALE");
        Uri uri = Uri.parse(stored);
        if (!hasPersistedAccess(uri)) throw new PluginFailure("Folder access has been revoked", "ACCESS_REVOKED");
        if (scopeId != null) {
            FolderAccess scope = readScopes.get(scopeId);
            if (!allowReadScope || scope == null || !scope.treeUri.equals(uri)) {
                throw new PluginFailure("Invalid or closed read scope", "UNREACHABLE");
            }
            return scope;
        }
        return new FolderAccess(uri);
    }

    private boolean hasPersistedAccess(Uri uri) {
        return getContext().getContentResolver().getPersistedUriPermissions().stream().anyMatch(permission ->
            permission.getUri().equals(uri) && permission.isReadPermission() && permission.isWritePermission()
        );
    }

    private String path(PluginCall call, boolean allowRoot) throws PluginFailure {
        return validatePath(call.getString("path"), allowRoot);
    }

    /** A project-relative path: no root, empty, `.` or `..` segment and no backslash or NUL. */
    private static String validatePath(String value, boolean allowRoot) throws PluginFailure {
        if (value == null && allowRoot) return "";
        if (value == null) throw new PluginFailure("path is required", null);
        if (value.isEmpty() && allowRoot) return value;
        if (value.isEmpty() || value.startsWith("/") || value.startsWith("\\") || value.contains("\\") || value.indexOf('\0') >= 0) {
            throw new PluginFailure("Path escapes project root", null);
        }
        for (String part : value.split("/", -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) throw new PluginFailure("Path escapes project root", null);
        }
        return value;
    }

    private Uri ensureDirectory(FolderAccess folder, Uri parent, String name) throws Exception {
        DocumentMetadata existing = findChild(folder, parent, name);
        if (existing != null) {
            if (!existing.directory) throw new PluginFailure("Path is not a directory", "NOT_FOUND");
            return existing.uri;
        }
        return createChild(folder, parent, DocumentsContract.Document.MIME_TYPE_DIR, name);
    }

    private Uri createChild(FolderAccess folder, Uri parent, String mimeType, String name) throws Exception {
        Uri created = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            parent,
            mimeType,
            name
        );
        if (created == null) throw new FileNotFoundException(name);
        Uri current = created;
        if (!name.equals(metadata(current).name)) {
            Uri renamed = DocumentsContract.renameDocument(getContext().getContentResolver(), current, name);
            if (renamed != null) current = renamed;
            if (!name.equals(metadata(current).name)) {
                DocumentsContract.deleteDocument(getContext().getContentResolver(), current);
                throw new PluginFailure("Provider renamed the created file", "UNREACHABLE");
            }
        }
        return current;
    }

    private DocumentMetadata resolve(FolderAccess folder, String path) throws Exception {
        Uri current = folder.rootUri;
        DocumentMetadata metadata = null;
        for (String part : path.split("/", -1)) {
            metadata = findChild(folder, current, part);
            if (metadata == null) throw new PluginFailure("File not found: " + path, "NOT_FOUND");
            current = metadata.uri;
        }
        return metadata;
    }

    /** A path cannot address one of two same-named children, so refuse it instead of picking one. */
    private DocumentMetadata findChild(FolderAccess folder, Uri parent, String name) throws Exception {
        List<DocumentMetadata> entries = children(folder, parent);
        DirectoryReadCache.Directory<DocumentMetadata> cached = folder.directories == null ? null : folder.directories.get(parent.toString());
        if (cached != null) {
            if (cached.duplicateNames.contains(name)) throw duplicateName(name);
            return cached.byName.get(name);
        }
        DocumentMetadata found = null;
        for (DocumentMetadata child : entries) {
            if (!name.equals(child.name)) continue;
            if (found != null) throw duplicateName(name);
            found = child;
        }
        return found;
    }

    private static PluginFailure duplicateName(String name) {
        return new PluginFailure("More than one entry is named " + name, null);
    }

    private List<DocumentMetadata> children(FolderAccess folder, Uri parent) throws Exception {
        DirectoryReadCache.Directory<DocumentMetadata> cached = folder.directories == null ? null : folder.directories.get(parent.toString());
        if (cached != null) return cached.entries;
        java.util.ArrayList<DocumentMetadata> result = new java.util.ArrayList<>();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            folder.treeUri,
            DocumentsContract.getDocumentId(parent)
        );
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        try (Cursor cursor = getContext().getContentResolver().query(childrenUri, projection, null, null, null)) {
            if (cursor == null) throw new FileNotFoundException(parent.toString());
            while (cursor.moveToNext()) {
                String documentId = cursor.getString(0);
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(folder.treeUri, documentId);
                result.add(fromCursor(cursor, uri));
            }
        }
        if (folder.directories != null) folder.directories.put(parent.toString(), result, entry -> entry.name);
        return result;
    }

    private DocumentMetadata metadata(Uri uri) throws Exception {
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        try (Cursor cursor = getContext().getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new FileNotFoundException(uri.toString());
            return fromCursor(cursor, uri);
        }
    }

    private DocumentMetadata fromCursor(Cursor cursor, Uri uri) {
        String name = cursor.getString(1);
        boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2));
        long size = cursor.isNull(3) ? 0L : cursor.getLong(3);
        long modified = cursor.isNull(4) ? 0L : cursor.getLong(4);
        return new DocumentMetadata(uri, name, directory, size, modified);
    }

    private String displayName(Uri uri) throws Exception {
        return metadata(uri).name;
    }

    private JSObject metadataObject(DocumentMetadata metadata) {
        JSObject result = statObject(metadata);
        result.put("name", metadata.name);
        return result;
    }

    private JSObject statObject(DocumentMetadata metadata) {
        JSObject result = new JSObject();
        result.put("isDir", metadata.directory);
        result.put("size", metadata.directory ? 0L : metadata.size);
        result.put("mtime", metadata.modified);
        return result;
    }

    private JSObject folderResult(String id, String name) {
        JSObject folder = new JSObject();
        folder.put("id", id);
        folder.put("name", name);
        folder.put("supportsReadScope", true);
        JSObject result = new JSObject();
        result.put("folder", folder);
        return result;
    }

    private byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() > MAX_TRANSFER_BYTES - read) throw tooLarge();
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static PluginFailure tooLarge() {
        return new PluginFailure("File is too large to read at once", null);
    }

    private static String decodeUtf8(byte[] bytes) throws PluginFailure {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString();
        } catch (CharacterCodingException error) {
            throw new PluginFailure("File is not valid UTF-8", "UNREACHABLE");
        }
    }
}
