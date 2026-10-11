package no.hideout.babylonslate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceCallback;
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
    private AudioDeviceCallback deviceCallback;
    private BroadcastReceiver noisyReceiver;
    private Object modeChangedListener;
    private boolean interrupted;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        deviceCallback = new AudioDeviceCallback() {
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

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) routeChange(2);
            }
        };
        ContextCompat.registerReceiver(
            getContext(),
            receiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        // Teardown unregisters only a receiver that registration accepted.
        noisyReceiver = receiver;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) registerModeListener();
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private void registerModeListener() {
        AudioManager.OnModeChangedListener listener = this::modeChanged;
        modeChangedListener = listener;
        audioManager.addOnModeChangedListener(ContextCompat.getMainExecutor(getContext()), listener);
        // The listener reports changes only; a call already in progress is the starting state.
        modeChanged(audioManager.getMode());
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

    private static boolean callActive(int mode) {
        switch (mode) {
            case AudioManager.MODE_RINGTONE:
            case AudioManager.MODE_IN_CALL:
            case AudioManager.MODE_IN_COMMUNICATION:
            case AudioManager.MODE_CALL_SCREENING:
            case AudioManager.MODE_CALL_REDIRECT:
            case AudioManager.MODE_COMMUNICATION_REDIRECT:
                return true;
            default:
                return false;
        }
    }

    private void modeChanged(int mode) {
        boolean active = callActive(mode);
        // Retained until the web listener attaches, so a call that began before
        // startup still pauses audio and its hang-up still resumes it.
        if (active && !interrupted) {
            interrupted = true;
            JSObject data = new JSObject();
            data.put("type", "began");
            notifyListeners("audioInterruption", data, true);
        } else if (!active && interrupted && mode == AudioManager.MODE_NORMAL) {
            interrupted = false;
            JSObject data = new JSObject();
            data.put("type", "ended");
            data.put("shouldResume", true);
            notifyListeners("audioInterruption", data, true);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (audioManager != null && deviceCallback != null) audioManager.unregisterAudioDeviceCallback(deviceCallback);
        if (audioManager != null && modeChangedListener != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            unregisterModeListener();
        }
        if (noisyReceiver != null) {
            try {
                getContext().unregisterReceiver(noisyReceiver);
            } catch (IllegalArgumentException ignored) {
                // Already unregistered; Capacitor teardown must still run.
            }
            noisyReceiver = null;
        }
        super.handleOnDestroy();
    }
}
