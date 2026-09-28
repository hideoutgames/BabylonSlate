package no.hideout.babylonslate;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "BabylonSlateSecrets")
public class BabylonSlateSecretsPlugin extends Plugin {
    private static final String KEY_ALIAS = "no.hideout.babylonslate.secrets";
    private static final String STORE_NAME = "babylonslate-secrets";
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(ANDROID_KEY_STORE);
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
        generator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build()
        );
        return generator.generateKey();
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("key is required");
            return;
        }
        String stored = preferences().getString(name, null);
        if (stored == null) {
            JSObject result = new JSObject();
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            String[] parts = stored.split(":", -1);
            if (parts.length != 2) throw new IllegalArgumentException("Invalid ciphertext");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            String value = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
            JSObject result = new JSObject();
            result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Keystore read failed", null, error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || name.isEmpty() || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
            if (!preferences().edit().putString(name, stored).commit()) throw new IllegalStateException("Preferences write failed");
            call.resolve();
        } catch (Exception error) {
            call.reject("Keystore write failed", null, error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("key is required");
            return;
        }
        if (!preferences().contains(name)) {
            call.resolve();
            return;
        }
        if (preferences().edit().remove(name).commit()) call.resolve();
        else call.reject("Keystore delete failed");
    }
}
