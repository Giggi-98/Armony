package io.github.giggi98.armony;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Aggiornamento dell'app dall'app stessa: scarica l'APK della release, ne verifica lo sha256
 * e lo passa all'installatore di Android, che chiede sempre conferma (fuori dal Play Store non
 * esiste un'installazione silenziosa, ed è giusto così).
 *   canInstall()                → { allowed }  Armony può già chiedere di installare app?
 *   install({ url, shaUrl })    → { status: 'permesso' | 'conferma' }
 *     l'impronta la legge il plugin: il redirect di GitHub verso i file delle release non ha CORS,
 *     quindi dalla pagina (origine http://localhost) il fetch del .sha256 verrebbe bloccato
 *   evento "progress": { received, total }   evento "status": { status: 'annullato' | 'errore', message }
 *
 * ─── PERCHÉ NON BASTA il link all'APK aperto nel browser ───
 * Il file finisce nella cartella Download, l'utente deve trovarlo e aprirlo da solo, e nessuno
 * controlla che sia proprio quello pubblicato: qui il download è verificato con lo sha256 della
 * release prima di arrivare all'installatore, e Android verifica a sua volta che la firma sia la
 * stessa dell'app già installata.
 */
@CapacitorPlugin(name = "ArmonyUpdate")
public class ArmonyUpdatePlugin extends Plugin {
    private static final String ACTION_STATUS = "io.github.giggi98.armony.ESITO_INSTALLAZIONE";
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private volatile boolean busy;

    private final BroadcastReceiver esito = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            int s = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (s == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                // la finestra di conferma di Android: decide l'utente
                Intent conferma = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent.class);
                if (conferma != null) ctx.startActivity(conferma.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            }
            if (s == PackageInstaller.STATUS_SUCCESS) return;  // l'app viene sostituita e riaperta da Android
            JSObject d = new JSObject();
            d.put("status", s == PackageInstaller.STATUS_FAILURE_ABORTED ? "annullato" : "errore");
            String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            d.put("message", msg == null ? "" : msg);
            notifyListeners("status", d);
        }
    };

    @Override
    public void load() {
        ContextCompat.registerReceiver(getContext(), esito, new IntentFilter(ACTION_STATUS), ContextCompat.RECEIVER_NOT_EXPORTED);
        dir().mkdirs();
        File[] vecchi = dir().listFiles();  // APK di aggiornamenti già installati o interrotti
        if (vecchi != null) for (File f : vecchi) f.delete();
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(esito); } catch (IllegalArgumentException ignored) {}
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", allowed());
        call.resolve(r);
    }

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", ""), shaUrl = call.getString("shaUrl", "");
        if (!url.startsWith("https://") || !shaUrl.startsWith("https://")) { call.reject("Aggiornamento senza indirizzo dell'APK o della sua impronta sha256"); return; }
        if (!allowed()) {
            // Android vuole che l'utente autorizzi Armony a installare app, una volta sola, dalle impostazioni
            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
            JSObject r = new JSObject();
            r.put("status", "permesso");
            call.resolve(r);
            return;
        }
        if (busy) { call.reject("C'è già un aggiornamento in corso"); return; }
        busy = true;
        net.execute(() -> {
            File apk = new File(dir(), "armony.apk"), shaFile = new File(dir(), "armony.apk.sha256");
            try {
                // l'impronta pubblicata con la release (file "<sha256>  armony-vX.Y.Z.apk"); senza, non si installa
                download(shaUrl, shaFile, false);
                byte[] raw = new byte[(int) Math.min(shaFile.length(), 4096)];
                try (InputStream in = new FileInputStream(shaFile)) { for (int off = 0, n; off < raw.length && (n = in.read(raw, off, raw.length - off)) > 0; ) off += n; }
                shaFile.delete();
                String sha = new String(raw).trim().split("\\s+")[0].toLowerCase();
                if (!sha.matches("[0-9a-f]{64}")) throw new IOException("impronta sha256 della release non valida");
                if (!download(url, apk, true).equals(sha)) {
                    apk.delete();
                    call.reject("Il file scaricato non corrisponde a quello pubblicato (sha256): aggiornamento annullato");
                    return;
                }
                commit(apk);
                JSObject r = new JSObject();
                r.put("status", "conferma");
                call.resolve(r);
            } catch (Exception e) {
                apk.delete();
                call.reject("Aggiornamento non riuscito: " + e.getMessage());
            } finally {
                busy = false;
            }
        });
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File dir() {
        return new File(getContext().getCacheDir(), "aggiornamento");
    }

    /** Scarica seguendo i redirect di GitHub (verso il suo archivio di file) e restituisce lo sha256. */
    private String download(String url, File out, boolean report) throws Exception {
        HttpURLConnection c = null;
        for (int i = 0; i < 6; i++) {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() / 100 != 3) break;
            url = c.getHeaderField("Location");
            c.disconnect();
            if (url == null || !url.startsWith("https://")) throw new IOException("redirect non valido");
        }
        if (c.getResponseCode() != 200) throw new IOException("risposta " + c.getResponseCode());
        long total = c.getContentLengthLong(), received = 0, sent = 0;
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) {
                o.write(buf, 0, n);
                md.update(buf, 0, n);
                received += n;
                if (report && (received - sent >= 128 * 1024 || received == total)) { sent = received; progress(received, total); }
            }
        } finally {
            c.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    private void progress(long received, long total) {
        JSObject d = new JSObject();
        d.put("received", received);
        d.put("total", total);
        notifyListeners("progress", d);
    }

    /** Sessione dell'installatore: l'esito (e la richiesta di conferma) arriva al receiver "esito". */
    private void commit(File apk) throws IOException {
        Context ctx = getContext();
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(ctx.getPackageName());
        int id = pi.createSession(p);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (OutputStream o = s.openWrite("armony.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                s.fsync(o);
            }
            // mutabile: l'installatore ci aggiunge l'esito e la richiesta di conferma
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent cb = PendingIntent.getBroadcast(ctx, id, new Intent(ACTION_STATUS).setPackage(ctx.getPackageName()), flags);
            s.commit(cb.getIntentSender());
        }
    }
}
