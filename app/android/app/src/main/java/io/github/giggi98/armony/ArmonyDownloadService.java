package io.github.giggi98.armony;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * I download sul telefono, uno alla volta, anche a schermo spento: servizio in primo piano con la notifica
 * («Scarico 2 di 5: Titolo»). Il brano lo prepara e scarica Scaricatore; qui finisce in Music/Armony/Artista/Album
 * attraverso MediaStore, così lo vedono le altre app, resta se si disinstalla Armony e «Questo telefono» lo trova da
 * solo (ArmonyLibraryPlugin guarda MediaStore). La coda vive qui; il client la legge e la segue con ArmonyDownloadPlugin.
 */
public class ArmonyDownloadService extends Service {
    static final String CHANNEL = "armony_download";
    static final int NOTIFICATION_ID = 2;

    /** Un lavoro della coda: stato «in coda», «preparo», «scarico», «fatto», «errore», «c'era già». */
    static final class Lavoro {
        final String id;
        final Scaricatore.Brano brano;
        String stato = "in coda", errore;
        int progresso;
        long creato = System.currentTimeMillis();

        Lavoro(String id, Scaricatore.Brano b) { this.id = id; this.brano = b; }

        JSONObject json() {
            JSONObject o = brano.json();
            try {
                o.put("id", id).put("stato", stato).put("progresso", progresso).put("errore", errore).put("creato", creato);
            } catch (Exception ignored) { }
            return o;
        }
    }

    static final List<Lavoro> coda = new ArrayList<>();
    static ArmonyDownloadPlugin plugin;
    private static volatile boolean gira;
    private PowerManager.WakeLock cpu;
    private long ultimoAvviso;

    static synchronized void aggiungi(Context c, List<Scaricatore.Brano> brani) {
        for (Scaricatore.Brano b : brani) coda.add(new Lavoro(Long.toString(SystemClock.elapsedRealtimeNanos(), 36), b));
        Intent i = new Intent(c, ArmonyDownloadService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static synchronized JSONArray elenco() {
        JSONArray a = new JSONArray();
        for (Lavoro l : coda) a.put(l.json());
        return a;
    }

    /** Toglie i lavori finiti (fatti, errori, già presenti): quelli in corso restano. */
    static synchronized void pulisci() {
        coda.removeIf(l -> l.stato.equals("fatto") || l.stato.equals("errore") || l.stato.equals("c'era già"));
    }

    static synchronized Lavoro prossimo() {
        for (Lavoro l : coda) if (l.stato.equals("in coda")) return l;
        return null;
    }

    static synchronized int[] conta() {
        int fatti = 0, tutti = 0;
        for (Lavoro l : coda) { tutti++; if (!l.stato.equals("in coda") && !l.stato.equals("preparo") && !l.stato.equals("scarico")) fatti++; }
        return new int[] { fatti, tutti };
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Download", NotificationManager.IMPORTANCE_LOW));
        cpu = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "armony:download");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = notifica("Preparo i download…", 0, true);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION_ID, n);
        if (!gira) {
            gira = true;
            new Thread(this::giro, "armony-download").start();
        }
        return START_NOT_STICKY;
    }

    private Notification notifica(String testo, int progresso, boolean indeterminato) {
        Intent apri = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, apri, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Armony")
            .setContentText(testo)
            .setProgress(100, progresso, indeterminato)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setContentIntent(pi)
            .build();
    }

    private void avvisa(Lavoro l, boolean subito) {
        long ora = SystemClock.elapsedRealtime();
        if (!subito && ora - ultimoAvviso < 500) return;  // l'avanzamento al più due volte al secondo
        ultimoAvviso = ora;
        int[] c = conta();
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID,
            notifica("Scarico " + Math.min(c[0] + 1, c[1]) + " di " + c[1] + ": " + (l.brano.titolo == null ? "…" : l.brano.titolo), l.progresso, l.stato.equals("preparo")));
        ArmonyDownloadPlugin p = plugin;
        if (p != null) p.cambiato(l.json());
    }

    private void giro() {
        cpu.acquire(6 * 60 * 60 * 1000L);
        try {
            for (Lavoro l; (l = prossimo()) != null; ) fai(l);
        } finally {
            gira = false;
            if (cpu.isHeld()) cpu.release();
            stopForeground(true);
            stopSelf();
        }
    }

    private void fai(Lavoro l) {
        File tmp = null;
        try {
            l.stato = "preparo";
            avvisa(l, true);
            Scaricatore.Brano b = Scaricatore.prepara(l.brano.url, l.brano);  // completa lo stesso oggetto: la coda lo vede
            if (esiste(b)) {
                l.stato = "c'era già";
                avvisa(l, true);
                return;
            }
            l.stato = "scarico";
            tmp = Scaricatore.scarica(b, getCacheDir(), (n, tot) -> {
                l.progresso = tot > 0 ? (int) (n * 100 / tot) : 0;
                avvisa(l, false);
            });
            salva(tmp, b);
            l.stato = "fatto";
            l.progresso = 100;
        } catch (Throwable e) {
            l.stato = "errore";
            l.errore = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        } finally {
            if (tmp != null) tmp.delete();
            for (File f : getCacheDir().listFiles((d, n) -> n.endsWith(".part"))) f.delete();
            avvisa(l, true);
        }
    }

    static String cartella(Scaricatore.Brano b) {
        return Environment.DIRECTORY_MUSIC + "/Armony/" + Scaricatore.sicuro(b.artista) + "/" + Scaricatore.sicuro(b.album);
    }

    /** Il brano c'è già (stesso nome nella stessa cartella): non si scarica due volte. */
    private boolean esiste(Scaricatore.Brano b) {
        String nome = Scaricatore.nomeFile(b);
        if (Build.VERSION.SDK_INT >= 29) {
            try (Cursor c = getContentResolver().query(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), new String[] { MediaStore.Audio.Media._ID },
                    MediaStore.Audio.Media.RELATIVE_PATH + "=? AND " + MediaStore.Audio.Media.DISPLAY_NAME + "=?", new String[] { cartella(b) + "/", nome }, null)) {
                return c != null && c.moveToFirst();
            }
        }
        return new File(Environment.getExternalStorageDirectory(), cartella(b) + "/" + nome).exists();
    }

    /** Nella musica del telefono: MediaStore da Android 10 (niente permessi), il file e la scansione prima. */
    private void salva(File f, Scaricatore.Brano b) throws Exception {
        String nome = Scaricatore.nomeFile(b);
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Audio.Media.DISPLAY_NAME, nome);
            v.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4");
            v.put(MediaStore.Audio.Media.RELATIVE_PATH, cartella(b));
            v.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri u = cr.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (u == null) throw new Exception("Android non ha accettato il file");
            try (InputStream in = new FileInputStream(f); OutputStream out = cr.openOutputStream(u)) {
                copia(in, out);
            } catch (Exception e) {
                cr.delete(u, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.Audio.Media.IS_PENDING, 0);
            cr.update(u, v, null, null);
        } else {
            File dir = new File(Environment.getExternalStorageDirectory(), cartella(b));
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("Non posso scrivere in " + dir);
            File dest = new File(dir, nome);
            try (InputStream in = new FileInputStream(f); OutputStream out = new FileOutputStream(dest)) { copia(in, out); }
            MediaScannerConnection.scanFile(this, new String[] { dest.getAbsolutePath() }, new String[] { "audio/mp4" }, null);
        }
    }

    static void copia(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[256 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
