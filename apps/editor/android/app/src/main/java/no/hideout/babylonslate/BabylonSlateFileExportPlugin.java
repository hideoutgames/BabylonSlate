package no.hideout.babylonslate;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Exports a file the web layer streams in base64 chunks, since the WebView ignores anchor
 * downloads: begin creates an empty file in the app cache, append adds each chunk, and finish
 * opens the system save dialog and copies the file to the document the user creates. The file's
 * cache folder is removed when finish settles or on discard.
 */
@CapacitorPlugin(name = "BabylonSlateFileExport")
public class BabylonSlateFileExportPlugin extends Plugin {
    private static final class PendingExport {
        final File file;
        final String mimeType;

        PendingExport(File file, String mimeType) {
            this.file = file;
            this.mimeType = mimeType;
        }
    }

    private final Map<String, PendingExport> exports = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // Exports a previous launch never finished.
        deleteRecursively(root());
    }

    @PluginMethod
    public void begin(PluginCall call) {
        String name = call.getString("name");
        if (!isPlainFileName(name)) {
            call.reject("The export file name is not valid.");
            return;
        }
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String id = UUID.randomUUID().toString();
        File folder = new File(root(), id);
        File file = new File(folder, name);
        try {
            if (!folder.mkdirs() || !file.createNewFile()) throw new IOException("The export file could not be created");
        } catch (IOException error) {
            deleteRecursively(folder);
            call.reject("Couldn't prepare the file for saving.", null, error);
            return;
        }
        exports.put(id, new PendingExport(file, mimeType));
        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
    }

    @PluginMethod
    public void append(PluginCall call) {
        PendingExport pending = pendingExport(call.getString("id"), false);
        if (pending == null) {
            call.reject("The export is no longer available.");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("The export data is not valid.", null, error);
            return;
        }
        try (OutputStream output = new FileOutputStream(pending.file, true)) {
            output.write(bytes);
            call.resolve();
        } catch (IOException error) {
            call.reject("Couldn't prepare the file for saving.", null, error);
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        PendingExport pending = pendingExport(call.getString("id"), false);
        if (pending == null) {
            call.reject("The export is no longer available.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(documentType(pending.file.getName(), pending.mimeType));
        intent.putExtra(Intent.EXTRA_TITLE, pending.file.getName());
        try {
            startActivityForResult(call, intent, "saveDocumentResult");
        } catch (RuntimeException error) {
            discardExport(call.getString("id"));
            call.reject("Saving files is unavailable right now.", null, error);
        }
    }

    @ActivityCallback
    private void saveDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        String id = call.getString("id");
        PendingExport pending = pendingExport(id, true);
        if (pending == null) {
            call.reject("The export is no longer available.");
            return;
        }
        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            deleteRecursively(pending.file.getParentFile());
            call.resolve(outcome("cancelled"));
            return;
        }
        execute(() -> {
            try (
                InputStream input = new FileInputStream(pending.file);
                OutputStream output = getContext().getContentResolver().openOutputStream(target, "w")
            ) {
                if (output == null) throw new IOException("The chosen document cannot be written");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                call.resolve(outcome("saved"));
            } catch (IOException | SecurityException error) {
                call.reject("Couldn't save the file.", null, error);
            } finally {
                deleteRecursively(pending.file.getParentFile());
            }
        });
    }

    @PluginMethod
    public void discard(PluginCall call) {
        discardExport(call.getString("id"));
        call.resolve();
    }

    private void discardExport(String id) {
        PendingExport pending = pendingExport(id, true);
        if (pending != null) deleteRecursively(pending.file.getParentFile());
    }

    private PendingExport pendingExport(String id, boolean remove) {
        if (id == null) return null;
        return remove ? exports.remove(id) : exports.get(id);
    }

    /**
     * The type to create the document with. A provider appends the type's own extension to a name
     * whose extension it does not map to that type (`default.babsave` would become
     * `default.babsave.json`), so such names are created as generic binary files.
     */
    private static String documentType(String name, String mimeType) {
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mimeType.equals(mapped) ? mimeType : "application/octet-stream";
    }

    private File root() {
        return new File(getContext().getCacheDir(), "haptic-exports");
    }

    private static JSObject outcome(String value) {
        JSObject result = new JSObject();
        result.put("result", value);
        return result;
    }

    /** One path component: the web layer names the file, never where it goes. */
    private static boolean isPlainFileName(String name) {
        return name != null && !name.isEmpty() && name.length() <= 255 && !name.equals(".") && !name.equals("..")
            && name.indexOf('/') < 0 && name.indexOf('\0') < 0;
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
