package io.github.giggi98.armony;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

/**
 * Widget "In riproduzione" della schermata Home.
 *
 * Non ha uno stato suo: mostra quello di ArmonyMediaService (lo stesso della notifica, quindi anche il
 * brano di un altro dispositivo quando il telefono fa da telecomando). Lo ridisegna il servizio a ogni
 * apply(); mentre suona solo la barra avanza, ogni 15 s e solo a schermo acceso (ArmonyMediaService.tick).
 * I tasti mandano al servizio le stesse azioni dei tasti della notifica.
 *
 * Senza servizio (app chiusa, o niente suonato ancora) il widget dice "Niente in riproduzione" e ogni
 * tocco apre l'app: la musica la suona la WebView, quindi avviare il solo servizio non suonerebbe nulla.
 *
 * Tre impaginazioni scelte dalle misure che il launcher comunica: larga (copertina a sinistra), alta
 * (copertina sopra, come One UI) e piccola (copertina accanto ai testi).
 */
public class ArmonyWidget extends AppWidgetProvider {
    /** Extra dell'apertura dell'app: porta il client su "In riproduzione" (MainActivity.onNewIntent). */
    static final String EXTRA_NOW = "armony.ora";
    // copertina già ridotta e arrotondata: si rifà solo quando cambia quella del servizio.
    // 320 px bastano per il widget più grande e restano sotto il limite delle transazioni (~400 KB)
    private static final int ART_PX = 320;
    private static Bitmap artFrom, artSmall;

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, views(c, m, id));
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle options) {
        m.updateAppWidget(id, views(c, m, id));  // ridimensionato: forse cambia impaginazione
    }

    private static int[] ids(Context c, AppWidgetManager m) {
        return m.getAppWidgetIds(new ComponentName(c, ArmonyWidget.class));
    }

    static boolean any(Context c) {
        return ids(c, AppWidgetManager.getInstance(c)).length > 0;
    }

    /** Ridisegna tutto: brano, copertina, stato, tasti. */
    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (int id : ids(c, m)) m.updateAppWidget(id, views(c, m, id));
    }

    /** Solo la barra: senza copertina l'aggiornamento costa poco. */
    static void progress(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (int id : ids(c, m)) {
            RemoteViews v = new RemoteViews(c.getPackageName(), layout(m, id));
            v.setProgressBar(R.id.w_progress, 1000, permille(), false);
            m.partiallyUpdateAppWidget(id, v);
        }
    }

    /** Impaginazione dalle misure in verticale (larghezza minima, altezza massima), in dp. */
    private static int layout(AppWidgetManager m, int id) {
        Bundle o = m.getAppWidgetOptions(id);
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT);
        if (w == 0 || h == 0) return R.layout.widget_wide;  // misure non ancora arrivate: la forma predefinita, 4x2
        // larga solo se accanto alla copertina (alta quanto il widget) restano ~150 dp per i tre tasti
        if (w >= h + 160 && h < 220) return R.layout.widget_wide;
        return h >= 200 ? R.layout.widget_tall : R.layout.widget_compact;
    }

    private static RemoteViews views(Context c, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), layout(m, id));
        boolean on = ArmonyMediaService.instance != null;
        v.setOnClickPendingIntent(android.R.id.background, open(c, on));
        if (!on) {
            v.setTextViewText(R.id.w_title, c.getString(R.string.widget_idle));
            v.setTextViewText(R.id.w_artist, c.getString(R.string.widget_idle_sub));
            v.setImageViewResource(R.id.w_cover, R.drawable.widget_logo);
            v.setImageViewResource(R.id.w_toggle, R.drawable.widget_ic_play);
            v.setContentDescription(R.id.w_toggle, c.getString(R.string.widget_play));
            v.setOnClickPendingIntent(R.id.w_toggle, open(c, false));
            v.setViewVisibility(R.id.w_prev, View.GONE);
            v.setViewVisibility(R.id.w_next, View.GONE);
            v.setViewVisibility(R.id.w_progress, View.INVISIBLE);
            return v;
        }
        boolean playing = ArmonyMediaService.playing;
        v.setTextViewText(R.id.w_title, ArmonyMediaService.title);
        v.setTextViewText(R.id.w_artist, ArmonyMediaService.artist);
        Bitmap art = art();
        if (art != null) v.setImageViewBitmap(R.id.w_cover, art);
        else v.setImageViewResource(R.id.w_cover, R.drawable.widget_logo);
        v.setImageViewResource(R.id.w_toggle, playing ? R.drawable.widget_ic_pause : R.drawable.widget_ic_play);
        v.setContentDescription(R.id.w_toggle, c.getString(playing ? R.string.widget_pause : R.string.widget_play));
        v.setOnClickPendingIntent(R.id.w_prev, ArmonyMediaService.action(c, ArmonyMediaService.ACT_PREV));
        v.setOnClickPendingIntent(R.id.w_toggle, ArmonyMediaService.action(c, ArmonyMediaService.ACT_TOGGLE));
        v.setOnClickPendingIntent(R.id.w_next, ArmonyMediaService.action(c, ArmonyMediaService.ACT_NEXT));
        v.setViewVisibility(R.id.w_prev, View.VISIBLE);
        v.setViewVisibility(R.id.w_next, View.VISIBLE);
        v.setViewVisibility(R.id.w_progress, ArmonyMediaService.durationMs > 0 ? View.VISIBLE : View.INVISIBLE);
        v.setProgressBar(R.id.w_progress, 1000, permille(), false);
        return v;
    }

    /** Dove siamo nel brano, stimato dall'ultima posizione nota del client. */
    private static int permille() {
        long d = ArmonyMediaService.durationMs, p = ArmonyMediaService.positionMs;
        if (d <= 0) return 0;
        if (ArmonyMediaService.playing) p += (long) ((SystemClock.elapsedRealtime() - ArmonyMediaService.positionAt) * ArmonyMediaService.rate);
        return (int) Math.max(0, Math.min(1000, p * 1000 / d));
    }

    /** Apre l'app; mentre c'è un brano la porta su "In riproduzione". */
    private static PendingIntent open(Context c, boolean now) {
        Intent i = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_NOW, now);
        // codici diversi da quello della notifica (0): un PendingIntent uguale ignorerebbe l'extra
        return PendingIntent.getActivity(c, now ? 11 : 10, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static Bitmap art() {
        Bitmap a = ArmonyMediaService.art;
        if (a != artFrom) { artFrom = a; artSmall = a == null ? null : round(a); }
        return artSmall;
    }

    /** Quadrato centrale, ridotto a ART_PX e con gli angoli arrotondati (anche sugli Android senza ritaglio dei widget). */
    private static Bitmap round(Bitmap a) {
        int side = Math.min(a.getWidth(), a.getHeight()), out = Math.min(side, ART_PX);
        float k = out / (float) side;
        Matrix mx = new Matrix();
        mx.setScale(k, k);
        mx.postTranslate(-(a.getWidth() - side) / 2f * k, -(a.getHeight() - side) / 2f * k);
        BitmapShader sh = new BitmapShader(a, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        sh.setLocalMatrix(mx);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        p.setShader(sh);
        Bitmap b = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888);
        float r = out * 0.1f;
        new Canvas(b).drawRoundRect(new RectF(0, 0, out, out), r, r, p);
        return b;
    }
}
