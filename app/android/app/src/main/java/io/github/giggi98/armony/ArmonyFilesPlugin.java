package io.github.giggi98.armony;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * File e avvisi dell'app. Nella WebView un link con "download" non fa niente (e un indirizzo blob: non arriva al
 * DownloadManager): esportazioni, immagini delle statistiche, registro e backup passano da qui.
 *  save      → Download/Armony (MediaStore; sotto Android 10 si condivide, senza chiedere permessi di scrittura)
 *  share     → il foglio «Condividi» di Android (FileProvider della cache)
 *  notify    → una notifica del canale «Avvisi»; il tocco apre l'app sull'indirizzo #/… indicato
 *  notifySetup, notifySeen → le notifiche ad app chiusa: ArmonyNotificheWorker le chiede al server ogni 15 minuti
 */
@CapacitorPlugin(
    name = "ArmonyFiles",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class ArmonyFilesPlugin extends Plugin {
    static final String CHANNEL = "armony_avvisi";
    static final String EXTRA_LINK = "armony.link";
    static String pending;  // indirizzo di una notifica toccata ad app chiusa: lo chiede il client all'avvio

    private static byte[] bytes(PluginCall call) {
        String d = call.getString("data", "");
        int c = d.indexOf(',');
        return Base64.decode(d.startsWith("data:") && c > 0 ? d.substring(c + 1) : d, Base64.DEFAULT);
    }

    private static String clean(String n) {
        String s = n == null ? "" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        return s.isEmpty() ? "armony" : s;
    }

    @PluginMethod
    public void save(PluginCall call) {
        String name = clean(call.getString("name")), mime = call.getString("mime", "application/octet-stream");
        if (Build.VERSION.SDK_INT < 29) { share(call); return; }
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Armony");
            ContentResolver cr = getContext().getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("non riesco a creare il file");
            try (OutputStream out = cr.openOutputStream(uri)) { out.write(bytes(call)); }
            JSObject r = new JSObject();
            r.put("where", "Download/Armony/" + name);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Salvataggio non riuscito: " + e.getMessage());
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        String name = clean(call.getString("name")), mime = call.getString("mime", "application/octet-stream");
        try {
            File dir = new File(getContext().getCacheDir(), "condivisi");
            dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes(call)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String text = call.getString("text");
            if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
            Intent chooser = Intent.createChooser(send, call.getString("title", name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooser);
            JSObject r = new JSObject();
            r.put("where", "shared");
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Condivisione non riuscita: " + e.getMessage());
        }
    }

    // ------------------------------------------------ notifiche (gli avvisi del server, con l'app in sottofondo)
    @PluginMethod
    public void notifyPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED) { granted(call); return; }
        requestPermissionForAlias("notifications", call, "granted");
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void granted(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        try {
            post(getContext(), call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff)), call.getString("title", "Armony"),
                 call.getString("body", ""), call.getString("link", ""));
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Notifiche non consentite");
        }
    }

    /** Lo stesso id della notifica sul server: se arriva sia dall'app sia dal worker, la seconda prende il posto della prima. */
    static void post(Context c, int id, String title, String body, String link) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Avvisi", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Importazioni e download finiti, amici in Jam, dispositivi da approvare");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (link != null && link.startsWith("#/")) open.putExtra(EXTRA_LINK, link);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_armony)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true);
        NotificationManagerCompat.from(c).notify("avviso", id, b.build());
    }

    // ------------------------------------------------ notifiche ad app chiusa (ArmonyNotificheWorker)
    /** url, token (gettone del server, vale solo per le notifiche nuove), last, kinds ("import,download,…"), on. */
    @PluginMethod
    public void notifySetup(PluginCall call) {
        Context c = getContext();
        android.content.SharedPreferences.Editor e = c.getSharedPreferences(ArmonyNotificheWorker.PREFS, Context.MODE_PRIVATE).edit();
        boolean on = call.getBoolean("on", false);
        if (call.getString("url") != null) e.putString("url", call.getString("url"));
        if (call.getString("token") != null) e.putString("token", call.getString("token"));
        if (call.getString("kinds") != null) e.putString("kinds", call.getString("kinds"));
        e.putLong("last", Math.max(c.getSharedPreferences(ArmonyNotificheWorker.PREFS, Context.MODE_PRIVATE).getLong("last", 0), call.getInt("last", 0)));
        e.putBoolean("on", on).apply();
        if (on) ArmonyNotificheWorker.schedule(c); else ArmonyNotificheWorker.cancel(c);
        call.resolve();
    }

    /** L'app ha già mostrato (o letto) le notifiche fino a questo id: il worker non le ripete. */
    @PluginMethod
    public void notifySeen(PluginCall call) {
        android.content.SharedPreferences p = getContext().getSharedPreferences(ArmonyNotificheWorker.PREFS, Context.MODE_PRIVATE);
        p.edit().putLong("last", Math.max(p.getLong("last", 0), call.getInt("last", 0))).apply();
        call.resolve();
    }

    /** L'indirizzo della notifica toccata ad app chiusa (una volta sola). */
    @PluginMethod
    public void pending(PluginCall call) {
        JSObject r = new JSObject();
        r.put("link", pending);
        pending = null;
        call.resolve(r);
    }

    static String linkOf(Intent i) {
        String l = i == null ? null : i.getStringExtra(EXTRA_LINK);
        return l != null && l.matches("#/[A-Za-z0-9/_%.\\-]*") ? l : null;
    }
}
