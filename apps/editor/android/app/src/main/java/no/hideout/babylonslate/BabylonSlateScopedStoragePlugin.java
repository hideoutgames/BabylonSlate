package no.hideout.babylonslate;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

@CapacitorPlugin(name = "BabylonSlateScopedStorage")
public class BabylonSlateScopedStoragePlugin extends Plugin {
    private static final String STORE_NAME = "babylonslate-scoped-storage";
    private static final String URI_PREFIX = "uri:";
    private static final String NAME_PREFIX = "name:";
    private boolean pickPending;

    private static class PluginFailure extends Exception {
        final String code;

        PluginFailure(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private static class FolderAccess {
        final Uri treeUri;
        final Uri rootUri;

        FolderAccess(Uri treeUri) {
            this.treeUri = treeUri;
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
        pickPending = true;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickFolderResult");
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
    public void readFile(PluginCall call) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
            String path = path(call, false);
            Uri target = resolve(folder, path).uri;
            try (InputStream input = getContext().getContentResolver().openInputStream(target)) {
                if (input == null) throw new FileNotFoundException(path);
                byte[] bytes = readAll(input);
                String encoding = call.getString("encoding", "utf8");
                String data = "base64".equals(encoding)
                    ? Base64.encodeToString(bytes, Base64.NO_WRAP)
                    : new String(bytes, StandardCharsets.UTF_8);
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
        final byte[] payload;
        try {
            payload = "base64".equals(call.getString("encoding", "utf8"))
                ? Base64.decode(data, Base64.DEFAULT)
                : data.getBytes(StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            call.reject("data is not valid base64");
            return;
        }
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
            String path = path(call, false);
            String[] parts = path.split("/", -1);
            Uri parent = folder.rootUri;
            for (int index = 0; index < parts.length - 1; index++) {
                parent = ensureDirectory(folder, parent, parts[index]);
            }
            DocumentMetadata existing = findChild(folder, parent, parts[parts.length - 1]);
            Uri target = existing == null
                ? createChild(folder, parent, "application/octet-stream", parts[parts.length - 1])
                : existing.uri;
            if (existing != null && existing.directory) throw new PluginFailure("File not found", "NOT_FOUND");
            try (OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) throw new FileNotFoundException(path);
                output.write(payload);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
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
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
            String path = path(call, false);
            DocumentMetadata target = resolve(folder, path);
            DocumentFile document = DocumentFile.fromSingleUri(getContext(), target.uri);
            if (document == null || !document.delete()) throw new FileNotFoundException(path);
            call.resolve();
        });
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
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
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
            String path = path(call, true);
            call.resolve(statObject(path.isEmpty() ? metadata(folder.rootUri) : resolve(folder, path)));
        });
    }

    @PluginMethod
    public void exists(PluginCall call) {
        executeFileOperation(call, () -> {
            FolderAccess folder = folder(call);
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

    private void executeFileOperation(PluginCall call, FileOperation operation) {
        execute(() -> {
            try {
                operation.run();
            } catch (PluginFailure error) {
                call.reject(error.getMessage(), error.code, error);
            } catch (SecurityException error) {
                call.reject("Folder access has been revoked", "ACCESS_REVOKED", error);
            } catch (FileNotFoundException error) {
                call.reject("File not found", "NOT_FOUND", error);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Scoped storage operation failed" : error.getMessage(), null, error);
            }
        });
    }

    private FolderAccess folder(PluginCall call) throws PluginFailure {
        String id = call.getString("folder");
        if (id == null || id.isEmpty()) throw new PluginFailure("folder is required", "NOT_FOUND");
        String stored = preferences().getString(URI_PREFIX + id, null);
        if (stored == null) throw new PluginFailure("Project folder is no longer available; reconnect required", "STALE");
        Uri uri = Uri.parse(stored);
        if (!hasPersistedAccess(uri)) throw new PluginFailure("Folder access has been revoked", "ACCESS_REVOKED");
        return new FolderAccess(uri);
    }

    private boolean hasPersistedAccess(Uri uri) {
        return getContext().getContentResolver().getPersistedUriPermissions().stream().anyMatch(permission ->
            permission.getUri().equals(uri) && permission.isReadPermission() && permission.isWritePermission()
        );
    }

    private String path(PluginCall call, boolean allowRoot) throws PluginFailure {
        String value = call.getString("path");
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

    private DocumentMetadata findChild(FolderAccess folder, Uri parent, String name) throws Exception {
        for (DocumentMetadata child : children(folder, parent)) if (name.equals(child.name)) return child;
        return null;
    }

    private List<DocumentMetadata> children(FolderAccess folder, Uri parent) throws Exception {
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
        JSObject result = new JSObject();
        result.put("folder", folder);
        return result;
    }

    private byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output.toByteArray();
    }
}
