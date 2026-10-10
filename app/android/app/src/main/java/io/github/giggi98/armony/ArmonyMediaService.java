package io.github.giggi98.armony;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;

/**
 * Tiene viva l'app mentre la musica suona e dà la notifica con i controlli.
 *
 * La musica la suona la WebView (motore audio in armony.js, con EQ e dissolvenza): questo
 * servizio non riproduce nulla. Serve perché Android non chiuda il processo a schermo spento,
 * per tenere svegli CPU e Wi-Fi mentre si ascolta, e per portare notifica, schermata di blocco
 * e tasti delle cuffie al client tramite ArmonyMediaPlugin.
 *
 * ─── PERCHÉ NON BASTA la Media Session del browser ───
 * Nella WebView di Android navigator.mediaSession non arriva al sistema: niente notifica,
 * niente tasti delle cuffie, e nessun servizio in primo piano che protegga il processo.
 */
public class ArmonyMediaService extends Service {
    static final String CHANNEL = "armony_riproduzione";
    static final int NOTIFICATION_ID = 1;
    static final String ACT_PREV = "armony.PREV", ACT_TOGGLE = "armony.TOGGLE", ACT_NEXT = "armony.NEXT";

    // stato attuale, scritto dal plugin sul thread principale
    static String title = "", artist = "", album = "";
    static Bitmap art;
    static boolean playing;
    static long positionMs, durationMs, positionAt;  // positionAt: elapsedRealtime() di positionMs
    static float rate = 1f;

    static ArmonyMediaService instance;
    static ArmonyMediaPlugin plugin;

    private MediaSessionCompat session;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    // barra del widget mentre suona: ogni 15 s e solo a schermo acceso, niente sveglie (ArmonyWidget)
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!playing) return;
            if (getSystemService(PowerManager.class).isInteractive()) ArmonyWidget.progress(ArmonyMediaService.this);
            handler.postDelayed(this, 15000);
        }
    };

    // cuffie staccate o Bluetooth che cade: Android lo annuncia prima di spostare l'audio sull'altoparlante. Pausa subito,
    // senza passare dal client (che arrivava un attimo dopo, con un frammento di musica dal telefono)
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (playing && AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) emit("pause", -1);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Riproduzione", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "Armony");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { emit("play", -1); }
            @Override public void onPause() { emit("pause", -1); }
            @Override public void onStop() { emit("pause", -1); }
            @Override public void onSkipToNext() { emit("next", -1); }
            @Override public void onSkipToPrevious() { emit("previous", -1); }
            @Override public void onSeekTo(long pos) { emit("seek", pos); }
        });
        session.setSessionActivity(openApp());
        session.setActive(true);
        cpu = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "armony:riproduzione");
        cpu.setReferenceCounted(false);
        wifi = ((WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE))
            .createWifiLock(Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "armony:riproduzione");
        wifi.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (plugin == null) {
            // tasto di un widget rimasto indietro con l'app chiusa: senza WebView non c'è niente da comandare.
            // Fermandosi, onDestroy riporta il widget a "Niente in riproduzione", che apre l'app
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACT_PREV.equals(a)) emit("previous", -1);
        else if (ACT_NEXT.equals(a)) emit("next", -1);
        else if (ACT_TOGGLE.equals(a)) emit(playing ? "pause" : "play", -1);
        apply();
        return START_NOT_STICKY;
    }

    /** Porta lo stato statico in sessione, notifica e blocchi. */
    void apply() {
        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (art != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, positionMs, playing ? rate : 0f)
            .build());

        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_armony)
            .setContentTitle(title)
            .setContentText(album.isEmpty() ? artist : artist + " · " + album)
            .setLargeIcon(art)
            .setContentIntent(openApp())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .addAction(android.R.drawable.ic_media_previous, "Precedente", action(ACT_PREV))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pausa" : "Riproduci", action(ACT_TOGGLE))
            .addAction(android.R.drawable.ic_media_next, "Successivo", action(ACT_NEXT))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .build();
        // resta in primo piano anche in pausa: ripartire dalla notifica con l'app in secondo piano
        // non può avviare un servizio in primo piano da Android 12 in poi
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION_ID, n);

        if (playing) { cpu.acquire(); wifi.acquire(); }
        else { if (cpu.isHeld()) cpu.release(); if (wifi.isHeld()) wifi.release(); }

        ArmonyWidget.refresh(this);
        handler.removeCallbacks(tick);
        if (playing && ArmonyWidget.any(this)) handler.postDelayed(tick, 15000);
    }

    private PendingIntent action(String a) { return action(this, a); }

    /** Le azioni dei tasti, uguali per notifica e widget. */
    static PendingIntent action(Context c, String a) {
        return PendingIntent.getService(c, a.hashCode(), new Intent(c, ArmonyMediaService.class).setAction(a), PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE);
    }

    private void emit(String action, long posMs) {
        if (plugin != null) plugin.fire(action, posMs);
    }

    @Override
    public void onTaskRemoved(Intent root) {
        // app chiusa dalle recenti: la WebView non c'è più, quindi niente da tenere vivo
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try { unregisterReceiver(noisy); } catch (IllegalArgumentException ignored) { }
        if (cpu.isHeld()) cpu.release();
        if (wifi.isHeld()) wifi.release();
        session.setActive(false);
        session.release();
        instance = null;
        handler.removeCallbacks(tick);
        ArmonyWidget.refresh(this);  // "Niente in riproduzione"
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
