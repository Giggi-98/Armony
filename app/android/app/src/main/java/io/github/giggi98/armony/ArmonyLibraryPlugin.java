package io.github.giggi98.armony;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.ContentObserver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Size;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * La musica nella memoria del telefono, per "Questo telefono" (Local in client/telefono.js).
 *   access() / requestAccess()   { granted }: READ_MEDIA_AUDIO da Android 13, READ_EXTERNAL_STORAGE prima
 *   scan({ offset, limit })      { tracks: [{ id, title, artist, album, albumArtist, track, year, duration (ms),
 *                                  genre, mime, size, modified (s), name }], total }   solo i brani "musica"
 *   upload({ id, url, token })   { code, body }: PUT del file a pezzi dal content://, mai tutto in memoria;
 *                                  evento "upload" { id, sent, total } ogni mezzo secondo
 *   evento "change"              MediaStore è cambiato (brani aggiunti o tolti), dopo 3 s di calma
 * Audio e copertine li serve Web (sotto) all'indirizzo dell'app: /_armony_/audio/<id> con le richieste
 * Range (la barra deve poter saltare) e /_armony_/cover/<id>?s=<lato>. Stessa origine della pagina, quindi
 * l'audio passa dal motore Web Audio (EQ, dissolvenza) come quello dei server.
 */
@CapacitorPlugin(
    name = "ArmonyLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class ArmonyLibraryPlugin extends Plugin {
    static final Uri MEDIA = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
    private final ExecutorService io = Executors.newSingleThreadExecutor(), up = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable changed = () -> notifyListeners("change", new JSObject());
    private ContentObserver obs;

    private static String alias() { return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage"; }

    private boolean granted() { return getPermissionState(alias()) == PermissionState.GRANTED; }

    @Override
    public void load() { watch(); }

    private void watch() {
        if (obs != null || !granted()) return;
        obs = new ContentObserver(main) {
            @Override public void onChange(boolean self) { main.removeCallbacks(changed); main.postDelayed(changed, 3000); }
        };
        getContext().getContentResolver().registerContentObserver(MEDIA, true, obs);
    }

    @Override
    protected void handleOnDestroy() {
        if (obs != null) getContext().getContentResolver().unregisterContentObserver(obs);
        io.shutdownNow();
        up.shutdownNow();
    }

    @PluginMethod
    public void access(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        call.resolve(r);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (granted()) access(call);
        else requestPermissionForAlias(alias(), call, "accessDone");
    }

    @PermissionCallback
    private void accessDone(PluginCall call) {
        watch();
        access(call);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        int offset = call.getInt("offset", 0), limit = call.getInt("limit", 500);
        io.execute(() -> {
            if (!granted()) { call.reject("Permesso negato", "denied"); return; }
            List<String> cols = new ArrayList<>(Arrays.asList(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.TRACK, MediaStore.Audio.Media.YEAR, MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.DISPLAY_NAME));
            // artista dell'album e genere sono colonne pubbliche solo da Android 11
            if (Build.VERSION.SDK_INT >= 30) { cols.add(MediaStore.Audio.Media.ALBUM_ARTIST); cols.add(MediaStore.Audio.Media.GENRE); }
            String sel = MediaStore.Audio.Media.IS_MUSIC + " != 0";
            try (Cursor c = getContext().getContentResolver().query(MEDIA, cols.toArray(new String[0]), sel, null, MediaStore.Audio.Media._ID)) {
                JSArray out = new JSArray();
                int total = c == null ? 0 : c.getCount();
                if (c != null && c.moveToPosition(offset)) do {
                    JSObject t = new JSObject();
                    t.put("id", c.getLong(0));
                    t.put("title", str(c, MediaStore.Audio.Media.TITLE));
                    t.put("artist", str(c, MediaStore.Audio.Media.ARTIST));
                    t.put("album", str(c, MediaStore.Audio.Media.ALBUM));
                    t.put("albumArtist", str(c, "album_artist"));
                    t.put("genre", str(c, "genre"));
                    t.put("track", num(c, MediaStore.Audio.Media.TRACK));
                    t.put("year", num(c, MediaStore.Audio.Media.YEAR));
                    t.put("duration", num(c, MediaStore.Audio.Media.DURATION));
                    t.put("mime", str(c, MediaStore.Audio.Media.MIME_TYPE));
                    t.put("size", num(c, MediaStore.Audio.Media.SIZE));
                    t.put("modified", num(c, MediaStore.Audio.Media.DATE_MODIFIED));
                    t.put("name", str(c, MediaStore.Audio.Media.DISPLAY_NAME));
                    out.put(t);
                } while (out.length() < limit && c.moveToNext());
                JSObject r = new JSObject();
                r.put("tracks", out);
                r.put("total", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Lettura della musica non riuscita: " + e.getMessage());
            }
        });
    }

    private static String str(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        String v = i < 0 ? null : c.getString(i);
        return v == null || v.equals(MediaStore.UNKNOWN_STRING) ? "" : v;
    }

    private static long num(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i < 0 || c.isNull(i) ? 0 : c.getLong(i);
    }

    // un file per volta, sul suo thread: i caricamenti lunghi non fermano gli altri plugin
    @PluginMethod
    public void upload(PluginCall call) {
        String id = call.getString("id", ""), url = call.getString("url", ""), token = call.getString("token", "");
        up.execute(() -> {
            HttpURLConnection c = null;
            try (AssetFileDescriptor fd = getContext().getContentResolver().openAssetFileDescriptor(ContentUris.withAppendedId(MEDIA, Long.parseLong(id)), "r")) {
                if (fd == null) throw new IOException("File non trovato");
                long len = fd.getLength();
                c = ArmonyNetPlugin.open(url);
                c.setRequestMethod("PUT");
                c.setDoOutput(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(180000);  // il server verifica il file prima di rispondere
                c.setRequestProperty("X-Token", token);
                c.setRequestProperty("Content-Type", "application/octet-stream");
                if (len >= 0) c.setFixedLengthStreamingMode(len); else c.setChunkedStreamingMode(1 << 16);
                try (InputStream in = fd.createInputStream(); OutputStream out = c.getOutputStream()) {
                    byte[] b = new byte[1 << 16];
                    long sent = 0, at = 0;
                    for (int n; (n = in.read(b)) > 0;) {
                        out.write(b, 0, n);
                        sent += n;
                        if (SystemClock.uptimeMillis() - at > 500) {
                            at = SystemClock.uptimeMillis();
                            JSObject e = new JSObject();
                            e.put("id", id);
                            e.put("sent", sent);
                            e.put("total", len);
                            notifyListeners("upload", e);
                        }
                    }
                }
                int code = c.getResponseCode();
                InputStream rs = code >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                if (rs != null) try (InputStream in = rs) { byte[] b = new byte[8192]; for (int n; (n = in.read(b)) > 0;) body.write(b, 0, n); }
                JSObject r = new JSObject();
                r.put("code", code);
                r.put("body", body.toString("UTF-8"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Caricamento non riuscito" : e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    // copertina del brano: miniatura di MediaStore (Android 10+) o immagine incorporata nel file
    static byte[] cover(Context ctx, long id, int size) {
        Uri uri = ContentUris.withAppendedId(MEDIA, id);
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                Bitmap b = ctx.getContentResolver().loadThumbnail(uri, new Size(size, size), null);
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                b.compress(Bitmap.CompressFormat.JPEG, 85, o);
                return o.toByteArray();
            } catch (Exception e) {
                return null;
            }
        }
        MediaMetadataRetriever m = new MediaMetadataRetriever();
        try {
            m.setDataSource(ctx, uri);
            return m.getEmbeddedPicture();
        } catch (Exception e) {
            return null;
        } finally {
            try { m.release(); } catch (Exception ignored) {}
        }
    }

    // per la notifica (ArmonyMediaPlugin): la copertina di un brano del telefono non passa dalla rete
    static Bitmap coverBitmap(Context ctx, String url) {
        Matcher m = Pattern.compile("/_armony_/cover/(\\d+)").matcher(url);
        byte[] b = m.find() ? cover(ctx, Long.parseLong(m.group(1)), 512) : null;
        return b == null ? null : BitmapFactory.decodeByteArray(b, 0, b.length);
    }

    /** Il WebViewClient di Capacitor, più le due strade /_armony_/ per i file del telefono. */
    static class Web extends BridgeWebViewClient {
        private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
        private final Context ctx;

        Web(Bridge bridge) {
            super(bridge);
            ctx = bridge.getContext();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String p = u.getPath();
            if (p != null && p.startsWith("/_armony_/") && "localhost".equals(u.getHost())) {
                String[] seg = p.split("/");
                try {
                    long id = Long.parseLong(seg[3]);
                    if ("audio".equals(seg[2])) return audio(id, req.getRequestHeaders());
                    if ("cover".equals(seg[2])) {
                        String s = u.getQueryParameter("s");
                        byte[] b = cover(ctx, id, Math.max(64, Math.min(1024, s == null ? 300 : Integer.parseInt(s))));
                        Map<String, String> h = new HashMap<>();
                        h.put("Cache-Control", "max-age=86400");
                        return b == null ? new WebResourceResponse("image/jpeg", null, 404, "Not Found", h, new ByteArrayInputStream(new byte[0]))
                            : new WebResourceResponse("image/jpeg", null, 200, "OK", h, new ByteArrayInputStream(b));
                    }
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
            }
            return super.shouldInterceptRequest(view, req);
        }

        private WebResourceResponse audio(long id, Map<String, String> headers) throws IOException {
            Uri uri = ContentUris.withAppendedId(MEDIA, id);
            ContentResolver cr = ctx.getContentResolver();
            AssetFileDescriptor fd = cr.openAssetFileDescriptor(uri, "r");
            if (fd == null) throw new IOException("File non trovato");
            long len = fd.getLength();
            String mime = cr.getType(uri);
            if (mime == null) mime = "audio/mpeg";
            InputStream in = fd.createInputStream();
            Map<String, String> h = new HashMap<>();
            h.put("Accept-Ranges", "bytes");
            String range = null;
            for (Map.Entry<String, String> e : headers.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();
            Matcher m = range == null || len < 0 ? null : RANGE.matcher(range);
            if (m == null || !m.find() || (m.group(1).isEmpty() && m.group(2).isEmpty())) {
                if (len >= 0) h.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(mime, null, 200, "OK", h, in);
            }
            long from, to;
            if (m.group(1).isEmpty()) { from = Math.max(0, len - Long.parseLong(m.group(2))); to = len - 1; }  // "bytes=-500": gli ultimi 500
            else { from = Long.parseLong(m.group(1)); to = m.group(2).isEmpty() ? len - 1 : Math.min(len - 1, Long.parseLong(m.group(2))); }
            if (from >= len || from > to) {
                in.close();
                h.put("Content-Range", "bytes */" + len);
                return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
            }
            for (long left = from; left > 0;) { long k = in.skip(left); if (k <= 0) throw new IOException("skip"); left -= k; }
            h.put("Content-Range", "bytes " + from + "-" + to + "/" + len);
            h.put("Content-Length", String.valueOf(to - from + 1));
            return new WebResourceResponse(mime, null, 206, "Partial Content", h, new Limited(in, to - from + 1));
        }
    }

    // legge al massimo n byte: la risposta a una Range finisce dove l'ha chiesta il lettore
    static class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long n) { super(in); left = n; }

        @Override public int read() throws IOException { if (left <= 0) return -1; int b = super.read(); if (b >= 0) left--; return b; }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }
}
