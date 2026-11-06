package no.hideout.babylonslate;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * Third-party sign-in in the system browser. The provider redirects to the
 * app's callback scheme, which MainActivity's intent filter routes back here;
 * coming back to the app without that redirect means the person closed it.
 */
@CapacitorPlugin(name = "BabylonSlateAuthSession")
public class BabylonSlateAuthSessionPlugin extends Plugin {
    private PluginCall pending;
    private String pendingScheme;
    private boolean leftApp;

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String scheme = call.getString("callbackScheme");
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || !"https".equals(uri.getScheme()) || scheme == null || scheme.isEmpty()) {
            call.reject("An https url and a callbackScheme are required");
            return;
        }
        // One sign-in at a time: a replaced one resolves as closed.
        finish(null);
        synchronized (this) {
            pending = call;
            pendingScheme = scheme;
            leftApp = false;
        }
        try {
            getActivity().startActivity(
                new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
            );
        } catch (ActivityNotFoundException error) {
            synchronized (this) {
                if (pending == call) {
                    pending = null;
                    pendingScheme = null;
                }
            }
            call.reject("No browser can open the sign-in page", error);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        String scheme;
        synchronized (this) {
            scheme = pendingScheme;
        }
        if (data != null && scheme != null && scheme.equalsIgnoreCase(data.getScheme())) {
            finish(data.toString());
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        synchronized (this) {
            if (pending != null) leftApp = true;
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // A redirect arrives through onNewIntent before onResume, so a pending
        // sign-in here came back without one.
        boolean closed;
        synchronized (this) {
            closed = pending != null && leftApp;
        }
        if (closed) finish(null);
    }

    private void finish(String url) {
        PluginCall call;
        synchronized (this) {
            call = pending;
            pending = null;
            pendingScheme = null;
            leftApp = false;
        }
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("url", url == null ? JSONObject.NULL : url);
        call.resolve(result);
    }
}
