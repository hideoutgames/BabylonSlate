package no.hideout.babylonslate;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BabylonSlateSecretsPlugin.class);
        registerPlugin(BabylonSlateScopedStoragePlugin.class);
        registerPlugin(BabylonSlateAudioLifecyclePlugin.class);
        registerPlugin(BabylonSlateMemoryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
