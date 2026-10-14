package io.github.giggi98.armony;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.mp4parser.Box;
import org.mp4parser.Container;
import org.mp4parser.boxes.apple.AppleAlbumBox;
import org.mp4parser.boxes.apple.AppleArtistBox;
import org.mp4parser.boxes.apple.AppleCoverBox;
import org.mp4parser.boxes.apple.AppleGenreBox;
import org.mp4parser.boxes.apple.AppleItemListBox;
import org.mp4parser.boxes.apple.AppleNameBox;
import org.mp4parser.boxes.apple.AppleRecordingYearBox;
import org.mp4parser.boxes.apple.AppleTrackNumberBox;
import org.mp4parser.boxes.iso14496.part12.ChunkOffsetBox;
import org.mp4parser.boxes.iso14496.part12.HandlerBox;
import org.mp4parser.boxes.iso14496.part12.MetaBox;
import org.mp4parser.boxes.iso14496.part12.MovieBox;
import org.mp4parser.boxes.iso14496.part12.UserDataBox;
import org.mp4parser.muxer.Movie;
import org.mp4parser.muxer.builder.DefaultMp4Builder;
import org.mp4parser.IsoFile;
import org.mp4parser.boxes.iso14496.part12.TrackBox;
import org.mp4parser.boxes.sampleentry.SampleEntry;
import org.mp4parser.muxer.AbstractTrack;
import org.mp4parser.muxer.Sample;
import org.mp4parser.muxer.SampleImpl;
import org.mp4parser.muxer.TrackMetaData;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.ListExtractor;
import org.schabi.newpipe.extractor.Page;
import org.schabi.newpipe.extractor.playlist.PlaylistInfo;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

/**
 * Scaricare musica sul telefono senza server (fase 2 di docs/PIANO-TELEFONO.md), senza niente di Android: così si
 * prova anche sul computer. ArmonyDownloadPlugin lo usa e mette il file in MediaStore.
 *   cerca(testo, n)          brani da YouTube Music (le versioni «canzone», con artista e copertina quadrata)
 *   brani(link)              un brano o tutti quelli di una playlist / album di YouTube (Music)
 *   prepara(link)            il brano con i metadati: YouTube Music, poi Deezer per album, anno, traccia, copertina
 *   scarica(brano, cartella) l'm4a (AAC) migliore, a pezzi; poi da DASH a MP4 normale con i tag e la copertina
 * NewPipeExtractor estrae i link (come yt-dlp sul server); mp4parser rimette insieme l'm4a, che YouTube dà a frammenti
 * (DASH): a frammenti la durata e il salto non vanno in tutti i lettori, e i tag non ci stanno.
 */
public final class Scaricatore {
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
    static final int PEZZO = 4 * 1024 * 1024;  // richieste a pezzi: YouTube rallenta chi scarica tutto di fila
    private static boolean pronto;

    public interface Avanzamento { void fatto(long scaricati, long totale); }

    /** Un brano: da YouTube, completato da Deezer. */
    public static final class Brano {
        public String url, titolo, artista, album, genere, copertina;
        public int anno, traccia, durata;  // durata in secondi
        public JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("url", url).put("titolo", titolo).put("artista", artista).put("album", album).put("genere", genere)
                    .put("copertina", copertina).put("anno", anno).put("traccia", traccia).put("durata", durata);
            } catch (Exception ignored) { }
            return o;
        }
        static Brano da(JSONObject o) {
            Brano b = new Brano();
            b.url = o.optString("url", null); b.titolo = o.optString("titolo", null); b.artista = o.optString("artista", null);
            b.album = o.optString("album", null); b.genere = o.optString("genere", null); b.copertina = o.optString("copertina", null);
            b.anno = o.optInt("anno"); b.traccia = o.optInt("traccia"); b.durata = o.optInt("durata");
            return b;
        }
    }

    // ------------------------------------------------------------------ rete per NewPipeExtractor
    static final class Rete extends Downloader {
        @Override
        public Response execute(Request r) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(r.url()).openConnection();
            c.setRequestMethod(r.httpMethod());
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            for (Map.Entry<String, List<String>> e : r.headers().entrySet())
                for (String v : e.getValue()) c.addRequestProperty(e.getKey(), v);
            if (r.dataToSend() != null) {
                c.setDoOutput(true);
                try (OutputStream o = c.getOutputStream()) { o.write(r.dataToSend()); }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = in == null ? "" : new String(leggi(in), "UTF-8");
            return new Response(code, c.getResponseMessage(), c.getHeaderFields(), body, c.getURL().toString());
        }
    }

    static synchronized void init() {
        if (!pronto) { NewPipe.init(new Rete()); pronto = true; }
    }

    static byte[] leggi(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        in.close();
        return b.toByteArray();
    }

    static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA);
        if (c.getResponseCode() >= 400) throw new IOException(url + ": " + c.getResponseCode());
        return new String(leggi(c.getInputStream()), "UTF-8");
    }

    // ------------------------------------------------------------------ cercare e leggere i link
    static StreamingService yt() { init(); return ServiceList.YouTube; }

    /** «Queen - Topic» è il canale automatico di YouTube Music: l'artista è Queen. */
    static String artista(String canale) {
        return canale == null ? "" : canale.replaceAll("\\s*-\\s*Topic$", "").replaceAll("(?i)VEVO$", "").trim();
    }

    /** La copertina più grande: quelle di YouTube Music si ingrandiscono cambiando =w120-h120 nell'indirizzo. */
    static String copertina(List<Image> imm) {
        if (imm == null || imm.isEmpty()) return null;
        String u = imm.get(imm.size() - 1).getUrl();
        return u.replaceAll("=w\\d+-h\\d+", "=w800-h800");
    }

    public static List<Brano> cerca(String q, int n) throws Exception {
        StreamingService s = yt();
        List<Brano> out = new ArrayList<>();
        for (String filtro : new String[] { YoutubeSearchQueryHandlerFactory.MUSIC_SONGS, YoutubeSearchQueryHandlerFactory.VIDEOS }) {
            SearchInfo si = SearchInfo.getInfo(s, s.getSearchQHFactory().fromQuery(q, Collections.singletonList(filtro), ""));
            for (InfoItem it : si.getRelatedItems()) {
                if (!(it instanceof StreamInfoItem) || out.size() >= n) continue;
                StreamInfoItem x = (StreamInfoItem) it;
                Brano b = new Brano();
                b.url = x.getUrl().replace("music.youtube.com", "www.youtube.com");
                b.titolo = x.getName();
                b.artista = artista(x.getUploaderName());
                b.durata = (int) x.getDuration();
                b.copertina = copertina(x.getThumbnails());
                out.add(b);
            }
            if (!out.isEmpty()) break;  // le canzoni di YouTube Music bastano; se non ce ne sono, i video
        }
        return out;
    }

    /** I link dei brani: uno solo, o tutti quelli di una playlist (anche un album di YouTube Music). */
    public static List<String> brani(String link) throws Exception {
        StreamingService s = yt();
        // un brano aperto da una playlist (watch?v=…&list=…) è quel brano: la playlist intera si scarica dal suo link
        if (link.contains("watch?v=") || link.contains("youtu.be/") || !link.contains("list="))
            return Collections.singletonList(link.replaceAll("[&?]list=[^&]*", ""));
        List<String> out = new ArrayList<>();
        PlaylistInfo p = PlaylistInfo.getInfo(s, link);
        for (StreamInfoItem x : p.getRelatedItems()) out.add(x.getUrl());
        Page pg = p.getNextPage();
        while (pg != null && out.size() < 500) {
            ListExtractor.InfoItemsPage<StreamInfoItem> more = PlaylistInfo.getMoreItems(s, link, pg);
            for (StreamInfoItem x : more.getItems()) out.add(x.getUrl());
            pg = more.getNextPage();
        }
        return out;
    }

    /** Titolo e artista da YouTube; «Artista - Titolo (Official Video)» si separa e si pulisce. */
    static Brano daInfo(StreamInfo info, Brano b) {
        if (b == null) b = new Brano();
        b.url = info.getUrl();
        if (b.titolo == null || b.titolo.isEmpty()) {
            String t = info.getName(), a = artista(info.getUploaderName());
            Matcher m = Pattern.compile("^(.+?)\\s+[-–—]\\s+(.+)$").matcher(t);
            if (!info.getUploaderName().endsWith(" - Topic") && m.matches()) { a = m.group(1); t = m.group(2); }
            b.titolo = pulisci(t);
            b.artista = a;
        }
        if (b.durata == 0) b.durata = (int) info.getDuration();
        if (b.copertina == null) b.copertina = copertina(info.getThumbnails());
        return b;
    }

    /** Via le aggiunte dei video: (Official Video), [Lyrics], HD, … (come la pulizia dei titoli sul server). */
    static String pulisci(String t) {
        return t.replaceAll("(?i)\\s*[\\(\\[](official\\s*)?(music\\s*)?(video|audio|lyrics?|lyric video|visualizer|hd|hq|4k)[^\\)\\]]*[\\)\\]]", "")
                .replaceAll("(?i)\\s*\\|.*$", "").trim();
    }

    // ------------------------------------------------------------------ Deezer: album, anno, traccia, copertina grande
    /** Il brano su Deezer con la durata più vicina (entro 10 s); completa ciò che YouTube non dice. */
    static void deezer(Brano b) {
        try {
            String tit = b.titolo.replaceAll("\\s*[\\(\\[].*$", "");
            JSONObject best = null;
            // come il server (metadati.riconosci_download): prima la ricerca strutturata, poi quella semplice
            for (String q : new String[] { "artist:\"" + b.artista + "\" track:\"" + tit + "\"", b.artista + " " + tit }) {
                JSONArray d = new JSONObject(get("https://api.deezer.com/2.0/search/track?limit=10&q=" + URLEncoder.encode(q, "UTF-8"))).optJSONArray("data");
                for (int i = 0; d != null && i < d.length() && best == null; i++) {
                    JSONObject x = d.getJSONObject(i);
                    if (norm(x.optString("title")).equals(norm(tit)) && (b.durata == 0 || Math.abs(x.optInt("duration") - b.durata) <= 8)) best = x;
                }
                if (best != null) break;
            }
            if (best == null) return;
            JSONObject t = new JSONObject(get("https://api.deezer.com/2.0/track/" + best.getLong("id")));
            JSONObject al = t.optJSONObject("album");
            if (al != null) {
                b.album = al.optString("title", b.album);
                if (!al.optString("cover_xl").isEmpty()) b.copertina = al.optString("cover_xl");
                String data = t.optString("release_date", al.optString("release_date", ""));
                if (data.length() >= 4) b.anno = Integer.parseInt(data.substring(0, 4));
                try {
                    JSONArray g = new JSONObject(get("https://api.deezer.com/2.0/album/" + al.getLong("id"))).optJSONObject("genres").optJSONArray("data");
                    if (g != null && g.length() > 0) b.genere = g.getJSONObject(0).optString("name");
                } catch (Exception ignored) { }
            }
            b.traccia = t.optInt("track_position", b.traccia);
            if (t.optJSONObject("artist") != null) b.artista = t.getJSONObject("artist").optString("name", b.artista);
            b.titolo = t.optString("title", b.titolo);
        } catch (Exception ignored) {
            // Deezer non risponde o non lo conosce: restano i dati di YouTube
        }
    }

    /** Per confrontare i titoli: minuscole, senza accenti, parentesi e punteggiatura. */
    static String norm(String s) {
        return java.text.Normalizer.normalize(s == null ? "" : s, java.text.Normalizer.Form.NFD).replaceAll("\\p{M}", "")
                .toLowerCase(Locale.ROOT).replaceAll("[\\(\\[].*?[\\)\\]]", "").replaceAll("[^a-z0-9]+", " ").trim();
    }

    public static Brano prepara(String link, Brano noto) throws Exception {
        StreamInfo info = StreamInfo.getInfo(yt(), link);
        Brano b = daInfo(info, noto);
        if (b.album == null || b.album.isEmpty()) deezer(b);
        if (b.album == null || b.album.isEmpty()) b.album = b.titolo;  // un singolo: l'album è il brano
        return b;
    }

    // ------------------------------------------------------------------ scaricare e confezionare
    static AudioStream migliore(StreamInfo info) throws IOException {
        AudioStream best = null;
        for (AudioStream a : info.getAudioStreams())
            if (a.getFormat() == MediaFormat.M4A && a.isUrl() && (best == null || a.getAverageBitrate() > best.getAverageBitrate())) best = a;
        if (best == null) throw new IOException("Nessun audio m4a per questo brano");
        return best;
    }

    /** Scarica a pezzi (Range): se la rete cade si riprende dal punto in cui era. */
    static void scaricaFile(String url, File f, Avanzamento av) throws IOException {
        long tot = -1;
        try (RandomAccessFile out = new RandomAccessFile(f, "rw")) {
            long pos = out.length();
            out.seek(pos);
            byte[] buf = new byte[64 * 1024];
            while (tot < 0 || pos < tot) {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Range", "bytes=" + pos + "-" + (pos + PEZZO - 1));
                int code = c.getResponseCode();
                if (code == 416) break;
                if (code >= 400) throw new IOException("YouTube ha risposto " + code);
                String cr = c.getHeaderField("Content-Range");  // bytes 0-4194303/5732112
                if (cr != null && cr.contains("/")) tot = Long.parseLong(cr.substring(cr.indexOf('/') + 1).trim());
                else if (tot < 0) tot = c.getContentLengthLong();
                try (InputStream in = c.getInputStream()) {
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        pos += n;
                        if (av != null) av.fatto(pos, tot);
                    }
                }
                if (code == 200) break;  // il server ha ignorato Range e mandato tutto
            }
        }
    }

    /**
     * La traccia audio di un MP4 a frammenti (DASH di YouTube), letta a mano: per ogni moof, tfhd e trun dicono dove sta
     * ogni campione e quanto dura. MovieCreator di mp4parser sbaglia gli indirizzi con «default-base-is-moof» (il modo
     * di YouTube) e l'audio usciva rovinato; il resto (scrivere l'MP4 normale) lo fa bene DefaultMp4Builder.
     */
    static final class Traccia extends AbstractTrack {
        final List<Sample> campioni = new ArrayList<>();
        final List<Long> durate = new ArrayList<>();
        final TrackMetaData md = new TrackMetaData();
        SampleEntry entry;
        private final RandomAccessFile raf;

        Traccia(File f) throws IOException {
            super("audio");
            raf = new RandomAccessFile(f, "r");
            MappedByteBuffer tutto = raf.getChannel().map(FileChannel.MapMode.READ_ONLY, 0, raf.length());
            IsoFile iso = new IsoFile(f.getAbsolutePath());
            try {
                TrackBox tb = iso.getMovieBox().getBoxes(TrackBox.class).get(0);
                entry = tb.getSampleTableBox().getSampleDescriptionBox().getBoxes(SampleEntry.class).get(0);
                md.setTimescale(tb.getMediaBox().getMediaHeaderBox().getTimescale());
                md.setLanguage(tb.getMediaBox().getMediaHeaderBox().getLanguage());
            } finally {
                iso.close();
            }
            md.setTrackId(1);
            md.setVolume(1f);
            md.setCreationTime(new java.util.Date());
            md.setModificationTime(md.getCreationTime());
            long pos = 0, n = raf.length();
            while (pos + 8 <= n) {
                long size = tutto.getInt((int) pos) & 0xffffffffL;
                String tipo = tipo(tutto, (int) pos + 4);
                int testa = 8;
                if (size == 1) { size = tutto.getLong((int) pos + 8); testa = 16; } else if (size == 0) size = n - pos;
                if (tipo.equals("moof")) moof(tutto, pos, (int) (pos + testa), (int) (pos + size));
                pos += size;
            }
            if (campioni.isEmpty()) throw new IOException("Nessun frammento audio");
        }

        static String tipo(ByteBuffer b, int at) {
            return new String(new byte[] { b.get(at), b.get(at + 1), b.get(at + 2), b.get(at + 3) }, java.nio.charset.StandardCharsets.ISO_8859_1);
        }

        /** I box figli di [da, a): tipo -> inizio del contenuto (dopo l'intestazione), in ordine. */
        static List<long[]> figli(ByteBuffer b, int da, int a, String voluto) {
            List<long[]> out = new ArrayList<>();
            for (int p = da; p + 8 <= a; ) {
                int size = b.getInt(p);
                if (size < 8) break;
                if (tipo(b, p + 4).equals(voluto)) out.add(new long[] { p + 8, p + size });
                p += size;
            }
            return out;
        }

        private void moof(MappedByteBuffer b, long inizioMoof, int da, int a) {
            for (long[] traf : figli(b, da, a, "traf")) {
                long[] tfhd = figli(b, (int) traf[0], (int) traf[1], "tfhd").get(0);
                int p = (int) tfhd[0], fl = b.getInt(p) & 0xffffff;
                p += 8;  // versione e flag, track_ID
                long base = inizioMoof, durDef = 0, dimDef = 0;
                if ((fl & 0x01) != 0) { base = b.getLong(p); p += 8; }
                if ((fl & 0x02) != 0) p += 4;
                if ((fl & 0x08) != 0) { durDef = b.getInt(p) & 0xffffffffL; p += 4; }
                if ((fl & 0x10) != 0) { dimDef = b.getInt(p) & 0xffffffffL; p += 4; }
                long dati = base;
                for (long[] trun : figli(b, (int) traf[0], (int) traf[1], "trun")) {
                    int q = (int) trun[0], tf = b.getInt(q) & 0xffffff, quanti = b.getInt(q + 4);
                    q += 8;
                    if ((tf & 0x01) != 0) { dati = base + b.getInt(q); q += 4; }
                    if ((tf & 0x04) != 0) q += 4;
                    for (int i = 0; i < quanti; i++) {
                        long dur = durDef, dim = dimDef;
                        if ((tf & 0x100) != 0) { dur = b.getInt(q) & 0xffffffffL; q += 4; }
                        if ((tf & 0x200) != 0) { dim = b.getInt(q) & 0xffffffffL; q += 4; }
                        if ((tf & 0x400) != 0) q += 4;
                        if ((tf & 0x800) != 0) q += 4;
                        ByteBuffer c = b.duplicate();
                        c.position((int) dati);
                        c.limit((int) (dati + dim));
                        campioni.add(new SampleImpl(c.slice(), entry));
                        durate.add(dur);
                        dati += dim;
                    }
                }
            }
        }

        @Override public List<SampleEntry> getSampleEntries() { return Collections.singletonList(entry); }
        @Override public long[] getSampleDurations() { long[] d = new long[durate.size()]; for (int i = 0; i < d.length; i++) d[i] = durate.get(i); return d; }
        @Override public TrackMetaData getTrackMetaData() { return md; }
        @Override public String getHandler() { return "soun"; }
        @Override public List<Sample> getSamples() { return campioni; }
        @Override public void close() throws IOException { raf.close(); }
    }

    /** Da DASH (frammenti) a MP4 normale, con i tag di iTunes che leggono Android e tutti i lettori. */
    static void confeziona(File dash, File out, Brano b, byte[] jpg) throws IOException {
        Traccia t = new Traccia(dash);
        Movie m = new Movie();
        m.addTrack(t);
        Container c = new DefaultMp4Builder().build(m);
        MovieBox moov = null;
        for (Box x : c.getBoxes()) if (x instanceof MovieBox) moov = (MovieBox) x;
        if (moov == null) throw new IOException("MP4 senza moov");
        AppleItemListBox ilst = new AppleItemListBox();
        AppleNameBox nome = new AppleNameBox(); nome.setValue(b.titolo); ilst.addBox(nome);
        AppleArtistBox art = new AppleArtistBox(); art.setValue(b.artista); ilst.addBox(art);
        if (b.album != null) { AppleAlbumBox al = new AppleAlbumBox(); al.setValue(b.album); ilst.addBox(al); }
        if (b.anno > 0) {
            java.util.Calendar cal = new java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("UTC"));
            cal.clear();
            cal.set(b.anno, 0, 1, 12, 0);
            AppleRecordingYearBox y = new AppleRecordingYearBox(); y.setDate(cal.getTime()); ilst.addBox(y);
        }
        if (b.traccia > 0) { AppleTrackNumberBox tn = new AppleTrackNumberBox(); tn.setA(b.traccia); tn.setB(0); ilst.addBox(tn); }
        if (b.genere != null && !b.genere.isEmpty()) { AppleGenreBox g = new AppleGenreBox(); g.setValue(b.genere); ilst.addBox(g); }
        if (jpg != null && jpg.length > 0) { AppleCoverBox cv = new AppleCoverBox(); cv.setJpg(jpg); ilst.addBox(cv); }
        HandlerBox h = new HandlerBox(); h.setHandlerType("mdir");
        MetaBox meta = new MetaBox(); meta.addBox(h); meta.addBox(ilst);
        UserDataBox udta = new UserDataBox(); udta.addBox(meta);
        moov.addBox(udta);
        // DefaultMp4Builder ha già scritto in stco dove sta l'audio, contando il moov senza i tag: il moov ora è più
        // lungo di udta (la copertina, soprattutto) e l'audio, che viene dopo, si sposta della stessa quantità
        long spostamento = udta.getSize();
        for (ChunkOffsetBox co : moov.getBoxes(ChunkOffsetBox.class, true)) {
            long[] o = co.getChunkOffsets();
            for (int i = 0; i < o.length; i++) o[i] += spostamento;
            co.setChunkOffsets(o);
        }
        try (FileOutputStream fo = new FileOutputStream(out); FileChannel ch = fo.getChannel()) { c.writeContainer(ch); }
        finally { t.close(); }
    }

    static byte[] scaricaCopertina(String url) {
        if (url == null) return null;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            return c.getResponseCode() < 400 ? leggi(c.getInputStream()) : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** Tutto: estrae, scarica in cartella/<id>.part, confeziona in cartella/<id>.m4a e lo restituisce. */
    public static File scarica(Brano b, File cartella, Avanzamento av) throws Exception {
        StreamInfo info = StreamInfo.getInfo(yt(), b.url);
        daInfo(info, b);
        AudioStream a = migliore(info);
        String id = info.getId();
        File part = new File(cartella, id + ".part"), out = new File(cartella, id + ".m4a");
        scaricaFile(a.getContent(), part, av);
        confeziona(part, out, b, scaricaCopertina(b.copertina));
        part.delete();
        return out;
    }

    /** Il nome del file: «01 Titolo.m4a», senza caratteri che Android o Windows rifiutano. */
    public static String nomeFile(Brano b) {
        String t = (b.traccia > 0 ? String.format(Locale.ROOT, "%02d ", b.traccia) : "") + b.titolo;
        return sicuro(t) + ".m4a";
    }

    public static String sicuro(String s) {
        String x = s == null ? "" : s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
        if (x.length() > 100) x = x.substring(0, 100).trim();
        return x.isEmpty() ? "Senza titolo" : x;
    }
}
