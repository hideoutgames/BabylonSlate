package com.haptic.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * An exported Haptic game: one full-screen WebView that plays the web game
 * packed in the APK's assets/game folder. The game is served from
 * https://appassets.androidplatform.net/game/ (a host reserved for app
 * content, never fetched from the network) with the cross-origin isolation
 * headers the editor and desktop games use. Links to other sites open in the
 * browser; the page cannot navigate away. Back reaches the game as Escape.
 */
public final class GameActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ROOT = "/game/";

    private WebView webView;
    /** An OnBackInvokedCallback on Android 13 and later; Object so older Androids never load the class. */
    private Object backCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Games start their audio without waiting for a tap, as installed apps do.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setSupportZoom(false);
        webView.setWebViewClient(new GameClient());
        // The player's service worker fetches through the same handler.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return serve(request.getUrl());
            }
        });
        setContentView(webView);
        hideSystemBars();

        if (Build.VERSION.SDK_INT >= 33) {
            OnBackInvokedCallback callback = this::sendEscape;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            backCallback = callback;
        }
        webView.loadUrl("https://" + HOST + ROOT + "index.html");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        sendEscape();
    }

    private void sendEscape() {
        webView.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE));
        webView.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE));
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.resumeTimers();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        webView.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((OnBackInvokedCallback) backCallback);
        }
        webView.destroy();
        super.onDestroy();
    }

    /** The game file for a URL on the game host, or null to leave other hosts to the network. */
    private WebResourceResponse serve(Uri url) {
        if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        Map<String, String> headers = new HashMap<>();
        headers.put("Cross-Origin-Opener-Policy", "same-origin");
        headers.put("Cross-Origin-Embedder-Policy", "require-corp");
        headers.put("Cross-Origin-Resource-Policy", "same-origin");
        headers.put("X-Content-Type-Options", "nosniff");
        if (path == null || !path.startsWith(ROOT) || path.contains("/../") || path.endsWith("/..") || path.contains("\\")) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
        String name = path.substring(ROOT.length());
        if (name.isEmpty()) name = "index.html";
        try {
            InputStream data = getAssets().open("game/" + name);
            String type = mimeType(name);
            String encoding = type.startsWith("text/") || type.endsWith("json") || type.endsWith("javascript") ? "utf-8" : null;
            return new WebResourceResponse(type, encoding, 200, "OK", headers, data);
        } catch (IOException missing) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    private static String mimeType(String name) {
        int dot = name.lastIndexOf('.');
        switch (dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT)) {
            case "html": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "wasm": return "application/wasm";
            case "txt": return "text/plain";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "svg": return "image/svg+xml";
            case "ktx2": return "image/ktx2";
            case "ogg": return "audio/ogg";
            case "mp3": return "audio/mpeg";
            case "wav": return "audio/wav";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            default: return "application/octet-stream";
        }
    }

    private final class GameClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return serve(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("https".equals(url.getScheme()) && HOST.equals(url.getHost())) return false;
            if ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException ignored) {
                    // No browser: the link does nothing.
                }
            }
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's process crashed or was reclaimed: start the game again rather than crash the app.
            recreate();
            return true;
        }
    }
}
