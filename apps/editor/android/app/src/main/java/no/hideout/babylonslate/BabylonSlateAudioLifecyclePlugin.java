package no.hideout.babylonslate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BabylonSlateAudioLifecycle")
public class BabylonSlateAudioLifecyclePlugin extends Plugin {
    private AudioManager audioManager;
    private AudioManager.AudioDeviceCallback deviceCallback;
    private BroadcastReceiver noisyReceiver;
    private Object modeChangedListener;
    private boolean interrupted;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        deviceCallback = new AudioManager.AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                routeChange(1);
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                routeChange(2);
            }
        };
        audioManager.registerAudioDeviceCallback(deviceCallback, new Handler(Looper.getMainLooper()));

        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) routeChange(2);
            }
        };
        ContextCompat.registerReceiver(
            getContext(),
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) registerModeListener();
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private void registerModeListener() {
        AudioManager.OnModeChangedListener listener = this::modeChanged;
        modeChangedListener = listener;
        audioManager.addOnModeChangedListener(ContextCompat.getMainExecutor(getContext()), listener);
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private void unregisterModeListener() {
        audioManager.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeChangedListener);
    }

    private void routeChange(int reason) {
        JSObject data = new JSObject();
        data.put("reason", reason);
        notifyListeners("audioRouteChange", data);
    }

    private void modeChanged(int mode) {
        boolean active = mode == AudioManager.MODE_RINGTONE || mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION;
        if (active && !interrupted) {
            interrupted = true;
            JSObject data = new JSObject();
            data.put("type", "began");
            notifyListeners("audioInterruption", data);
        } else if (!active && interrupted && mode == AudioManager.MODE_NORMAL) {
            interrupted = false;
            JSObject data = new JSObject();
            data.put("type", "ended");
            data.put("shouldResume", true);
            notifyListeners("audioInterruption", data);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (audioManager != null && deviceCallback != null) audioManager.unregisterAudioDeviceCallback(deviceCallback);
        if (audioManager != null && modeChangedListener != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            unregisterModeListener();
        }
        if (noisyReceiver != null) getContext().unregisterReceiver(noisyReceiver);
        super.handleOnDestroy();
    }
}
