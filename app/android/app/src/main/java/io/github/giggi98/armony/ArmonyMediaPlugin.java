package io.github.giggi98.armony;

import android.Manifest;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ponte fra il client (NativeMedia in armony.js) e ArmonyMediaService.
 *   update({ title, artist, album, artwork, playing, position, duration, rate })  posizioni in secondi
 *   stop()
 *   evento "action": { action: play | pause | next | previous | seek, position? }
 */
@CapacitorPlugin(
    name = "ArmonyMedia",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class ArmonyMediaPlugin extends Plugin {
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private String artUrl = "";
    private boolean asked;

    @Override
    public void load() {
        ArmonyMediaService.plugin = this;
    }

    @PluginMethod
    public void update(PluginCall call) {
        // Android 13+: la notifica va chiesta una volta; se l'utente dice no, la musica continua lo stesso
        if (Build.VERSION.SDK_INT >= 33 && !asked && getPermissionState("notifications") != PermissionState.GRANTED) {
            asked = true;
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        apply(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        apply(call);
    }

    private void apply(PluginCall call) {
        ArmonyMediaService.title = call.getString("title", "");
        ArmonyMediaService.artist = call.getString("artist", "");
        ArmonyMediaService.album = call.getString("album", "");
        ArmonyMediaService.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        ArmonyMediaService.positionMs = Math.round(call.getDouble("position", 0d) * 1000);
        ArmonyMediaService.durationMs = Math.round(call.getDouble("duration", 0d) * 1000);
        ArmonyMediaService.rate = call.getFloat("rate", 1f);
        String url = call.getString("artwork", "");
        if (!url.equals(artUrl)) {
            artUrl = url;
            ArmonyMediaService.art = null;
            if (!url.isEmpty()) net.execute(() -> {
                Bitmap b = load(url);
                getActivity().runOnUiThread(() -> {
                    if (!url.equals(artUrl)) return;  // nel frattempo è cambiato brano
                    ArmonyMediaService.art = b;
                    if (ArmonyMediaService.instance != null) ArmonyMediaService.instance.apply();
                });
            });
        }
        if (ArmonyMediaService.instance != null) ArmonyMediaService.instance.apply();
        else ContextCompat.startForegroundService(getContext(), new Intent(getContext(), ArmonyMediaService.class));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ArmonyMediaService.class));
        call.resolve();
    }

    void fire(String action, long posMs) {
        JSObject d = new JSObject();
        d.put("action", action);
        if (posMs >= 0) d.put("position", posMs / 1000.0);
        notifyListeners("action", d);
    }

    private static Bitmap load(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            try (InputStream in = c.getInputStream()) { return BitmapFactory.decodeStream(in); }
            finally { c.disconnect(); }
        } catch (Exception e) {
            return null;  // senza copertina la notifica funziona lo stesso
        }
    }
}
