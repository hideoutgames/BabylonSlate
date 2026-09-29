package no.hideout.babylonslate;

import android.app.ActivityManager;
import android.os.Process;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * Process and system memory counters for the Play debugger stats HUD.
 * The WebView renderer runs in a separate process, so this reports the host process only.
 */
@CapacitorPlugin(name = "BabylonSlateMemory")
public class BabylonSlateMemoryPlugin extends Plugin {
    @PluginMethod
    public void stats(PluginCall call) {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(ActivityManager.class);
        android.os.Debug.MemoryInfo processInfo = manager.getProcessMemoryInfo(new int[] { Process.myPid() })[0];
        ActivityManager.MemoryInfo systemInfo = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(systemInfo);
        JSObject result = new JSObject();
        result.put("appFootprintBytes", processInfo.getTotalPss() * 1024L);
        result.put("systemAvailableBytes", systemInfo.availMem);
        result.put("appAvailableBytes", JSONObject.NULL);
        call.resolve(result);
    }
}
