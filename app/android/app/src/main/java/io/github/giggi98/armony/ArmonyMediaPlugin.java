package io.github.giggi98.armony;

import android.Manifest;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
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
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ponte fra il client (NativeMedia in armony.js) e ArmonyMediaService.
 *   update({ title, artist, album, artwork, playing, position, duration, rate })  posizioni in secondi
 *   stop()
 *   evento "action": { action: play | pause | next | previous | seek, position? }
 *   output()  e evento "output" (trattenuto): { kind: bluetooth | wired | usb | speaker, name }
 *     l'uscita audio della musica in questo momento. getProductName() non chiede permessi
 *     (BLUETOOTH_CONNECT su Android 12+ serve solo per l'indirizzo, che qui non si usa)
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
        AudioManager am = getContext().getSystemService(AudioManager.class);
        // si chiama subito con i dispositivi già collegati, poi a ogni cuffia che entra o esce
        // (l'instradamento può cambiare un attimo dopo l'avviso: si ricontrolla dopo un secondo)
        Handler h = new Handler(Looper.getMainLooper());
        if (am != null) am.registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { fireOutput(); h.postDelayed(() -> fireOutput(), 1000); }
            @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { fireOutput(); h.postDelayed(() -> fireOutput(), 1000); }
        }, h);
    }

    @PluginMethod
    public void output(PluginCall call) {
        call.resolve(currentOutput());
    }

    private String lastOutput = "";

    private void fireOutput() {
        JSObject o = currentOutput();
        if (o.toString().equals(lastOutput)) return;
        lastOutput = o.toString();
        notifyListeners("output", o, true);
    }

    private JSObject currentOutput() {
        AudioManager am = getContext().getSystemService(AudioManager.class);
        AudioDeviceInfo dev = null;
        if (am != null && Build.VERSION.SDK_INT >= 33) {
            // dove Android manda davvero la musica adesso
            try {
                List<AudioDeviceInfo> l = am.getAudioDevicesForAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build());
                if (!l.isEmpty()) dev = l.get(0);
            } catch (RuntimeException ignored) {}
        }
        if (dev == null && am != null) {
            // Android più vecchi: la stessa precedenza che usa il sistema (Bluetooth, poi filo, poi USB)
            int best = 0;
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int r = rank(kind(d.getType()));
                if (r > best) { best = r; dev = d; }
            }
        }
        String k = dev == null ? "speaker" : kind(dev.getType());
        JSObject o = new JSObject();
        o.put("kind", k);
        CharSequence n = dev == null ? null : dev.getProductName();
        o.put("name", k.equals("speaker") || n == null ? "" : n.toString().trim());
        return o;
    }

    private static int rank(String k) {
        switch (k) { case "bluetooth": return 3; case "wired": return 2; case "usb": return 1; default: return 0; }
    }

    private static String kind(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_BLE_BROADCAST:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return "wired";
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
                return "usb";
            default:
                return "speaker";
        }
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
