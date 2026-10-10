package io.github.giggi98.armony;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * DNS di riserva e proxy locale dell'app (lo accende ArmonyNetPlugin). Java puro, senza Android:
 * si collauda anche sul PC (ArmonyDnsTest).
 *
 * Il proxy ascolta solo su 127.0.0.1, su una porta scelta dal sistema, e accetta solo
 * "CONNECT host:porta" verso i server configurati in Armony (e GitHub per gli aggiornamenti).
 * Il nome si risolve prima con il DNS del telefono; se non lo trova, o se l'indirizzo che dà non
 * risponde, con DNS-over-HTTPS (RFC 8484) verso un resolver pubblico chiamato per IP, così non
 * dipende a sua volta dal DNS. Poi copia i byte nei due sensi: il TLS resta fra WebView e server,
 * il certificato si verifica come sempre e il proxy non vede niente in chiaro.
 */
final class ArmonyDns {
    /** Resolver pubblici: indirizzo principale e di riserva (i certificati coprono gli IP). Quad9 risponde
     *  in DoH solo in HTTP/2, che HttpURLConnection non parla: per lui DNS-over-TLS (porta 853). */
    static String[] via(String name) {
        switch (name) {
            case "google": return new String[] {"8.8.8.8", "8.8.4.4"};
            case "quad9": return new String[] {"9.9.9.9", "149.112.112.112"};
            default: return new String[] {"1.1.1.1", "1.0.0.1"};  // cloudflare
        }
    }
    /** GitHub: controllo della versione (api), APK (github.com) e i suoi file (…githubusercontent.com) */
    static final List<String> GITHUB = Arrays.asList("github.com", "api.github.com", "*.githubusercontent.com");

    volatile String via = "cloudflare";
    volatile boolean system = true;  // false solo nelle prove: salta il DNS del telefono
    private volatile Set<String> hosts = Collections.emptySet();  // "host:porta", in minuscolo
    private final Map<String, Object[]> cache = new ConcurrentHashMap<>();  // host → { InetAddress[], scadenza ms }
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "armony-dns");
        t.setDaemon(true);
        return t;
    });
    private ServerSocket server;

    /** I server di Armony, come "host" o "host:porta" (443 se manca). */
    void setHosts(Iterable<String> list) {
        Set<String> s = new HashSet<>();
        for (String h : list) {
            h = h.trim().toLowerCase(Locale.ROOT);
            if (h.isEmpty()) continue;
            s.add(h.matches(".*:\\d+") ? h : h + ":443");
        }
        hosts = s;
    }

    /** Le regole per la WebView ("host:porta", più GitHub): solo queste passano dal proxy. */
    List<String> rules() {
        List<String> r = new ArrayList<>(hosts);
        for (String g : GITHUB) r.add(g + ":443");
        return r;
    }

    boolean allowed(String host, int port) {
        host = host.toLowerCase(Locale.ROOT);
        if (hosts.contains(host + ":" + port)) return true;
        return port == 443 && (host.equals("github.com") || host.equals("api.github.com") || host.endsWith(".githubusercontent.com"));
    }

    synchronized boolean running() { return server != null && !server.isClosed(); }
    synchronized int port() { return running() ? server.getLocalPort() : 0; }

    /** Avvia il proxy (se non è già acceso) e restituisce la porta. */
    synchronized int start() throws IOException {
        if (running()) return server.getLocalPort();
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        final ServerSocket ss = server;
        pool.execute(() -> {
            while (!ss.isClosed()) {
                try {
                    Socket c = ss.accept();
                    pool.execute(() -> serve(c));
                } catch (IOException e) { /* chiuso da stop() */ }
            }
        });
        return ss.getLocalPort();
    }

    synchronized void stop() {
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        server = null;
    }

    // ─── proxy ───

    private void serve(Socket c) {
        Socket s = null;
        try {
            c.setSoTimeout(10000);
            InputStream in = c.getInputStream();
            String[] line = head(in).split("\r\n", 2)[0].split(" ");
            if (line.length < 3 || !"CONNECT".equals(line[0])) { reply(c, "405 Method Not Allowed"); return; }
            int i = line[1].lastIndexOf(':');
            String host = i > 0 ? line[1].substring(0, i).replaceAll("^\\[|\\]$", "") : "";
            int port = i > 0 ? Integer.parseInt(line[1].substring(i + 1)) : -1;
            if (!allowed(host, port)) { reply(c, "403 Forbidden"); return; }
            try { s = connect(host, port); } catch (IOException e) { reply(c, "502 Bad Gateway"); return; }
            reply(c, "200 Connection Established");
            c.setSoTimeout(0);
            c.setTcpNoDelay(true);
            s.setTcpNoDelay(true);
            final Socket up = s;
            AtomicInteger left = new AtomicInteger(2);
            pool.execute(() -> pipe(up, c, left));
            pipe(c, up, left);
            s = null;  // le chiude pipe()
        } catch (Exception e) {
            close(c, s);
        }
    }

    /** Intestazione della richiesta, byte per byte: dopo la riga vuota non si legge niente in più. */
    private static String head(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int n = 0;
        for (int ch; (ch = in.read()) >= 0; ) {
            b.write(ch);
            n = ch == '\n' ? n + 1 : ch == '\r' ? n : 0;
            if (n == 2) return b.toString("ISO-8859-1");
            if (b.size() > 8192) break;
        }
        throw new IOException("intestazione non valida");
    }

    private static void reply(Socket c, String status) throws IOException {
        OutputStream o = c.getOutputStream();
        o.write(("HTTP/1.1 " + status + "\r\n" + (status.startsWith("200") ? "" : "Content-Length: 0\r\nConnection: close\r\n") + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
        o.flush();
        if (!status.startsWith("200")) c.close();
    }

    /** Copia da a verso b; alla fine chiude la scrittura di b. Il secondo verso che finisce chiude tutto. */
    private static void pipe(Socket a, Socket b, AtomicInteger left) {
        byte[] buf = new byte[64 * 1024];
        try {
            InputStream in = a.getInputStream();
            OutputStream out = b.getOutputStream();
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            b.shutdownOutput();
        } catch (IOException e) {
            left.set(1);  // errore: si chiude tutto subito
        }
        if (left.decrementAndGet() <= 0) close(a, b);
    }

    private static void close(Socket... ss) {
        for (Socket s : ss) try { if (s != null) s.close(); } catch (IOException ignored) {}
    }

    // ─── risoluzione ───

    /** Connessione TCP: indirizzi del DNS del telefono, poi quelli del DNS pubblico. */
    Socket connect(String host, int port) throws IOException {
        List<InetAddress> tried = new ArrayList<>();
        for (InetAddress a : systemLookup(host)) {
            if (tried.size() == 2) break;
            tried.add(a);
            Socket s = tryConnect(a, port, 4000);
            if (s != null) return s;
        }
        for (InetAddress a : doh(host)) {
            if (tried.contains(a)) continue;
            Socket s = tryConnect(a, port, 8000);
            if (s != null) return s;
        }
        throw new IOException("non raggiungibile: " + host);
    }

    private static Socket tryConnect(InetAddress a, int port, int ms) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(a, port), ms);
            return s;
        } catch (IOException e) {
            close(s);
            return null;
        }
    }

    /** DNS del telefono, al massimo 3 s; scarta le risposte dei filtri (0.0.0.0, 127.x). */
    private List<InetAddress> systemLookup(String host) {
        List<InetAddress> r = new ArrayList<>();
        if (!system) return r;
        try {
            for (InetAddress a : pool.submit(() -> InetAddress.getAllByName(host)).get(3, TimeUnit.SECONDS))
                if (!a.isAnyLocalAddress() && !a.isLoopbackAddress()) r.add(a);
        } catch (Exception ignored) { /* nome non trovato o DNS che non risponde */ }
        return r;
    }

    /** Indirizzi IPv4 dal resolver pubblico scelto, con cache fino alla scadenza (TTL, fra 30 s e 1 ora). */
    List<InetAddress> doh(String host) throws IOException {
        Object[] c = cache.get(host);
        if (c != null && (long) c[1] > System.currentTimeMillis()) return Arrays.asList((InetAddress[]) c[0]);
        String[] ips = via(via);
        IOException last = null;
        for (String ip : ips) {
            try {
                long[] ttl = {3600};
                List<InetAddress> r = parse("quad9".equals(via) ? tls(ip, query(host)) : post(ip, query(host)), ttl);
                if (r.isEmpty()) throw new IOException("nessun indirizzo per " + host);
                cache.put(host, new Object[] {r.toArray(new InetAddress[0]), System.currentTimeMillis() + Math.max(30, ttl[0]) * 1000});
                return r;
            } catch (IOException e) { last = e; }
        }
        throw last;
    }

    private static byte[] post(String ip, byte[] q) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL("https://" + ip + "/dns-query").openConnection();
        try {
            h.setConnectTimeout(3000);
            h.setReadTimeout(3000);
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/dns-message");
            h.setRequestProperty("Accept", "application/dns-message");
            try (OutputStream o = h.getOutputStream()) { o.write(q); }
            if (h.getResponseCode() != 200) throw new IOException("DoH " + ip + ": risposta " + h.getResponseCode());
            try (InputStream in = h.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) > 0 && b.size() < 65536; ) b.write(buf, 0, n);
                return b.toByteArray();
            }
        } finally { h.disconnect(); }
    }

    /** DNS-over-TLS (RFC 7858): il certificato deve valere per l'IP del resolver. */
    private static byte[] tls(String ip, byte[] q) throws IOException {
        try (SSLSocket s = (SSLSocket) SSLSocketFactory.getDefault().createSocket()) {
            s.connect(new InetSocketAddress(ip, 853), 3000);
            s.setSoTimeout(3000);
            s.startHandshake();  // verifica la catena dei certificati; il nome (qui l'IP) si controlla sotto
            boolean ok = false;
            Collection<List<?>> san = ((X509Certificate) s.getSession().getPeerCertificates()[0]).getSubjectAlternativeNames();
            if (san != null) for (List<?> e : san) ok |= Integer.valueOf(7).equals(e.get(0)) && ip.equals(e.get(1));
            if (!ok) throw new IOException("DoT " + ip + ": certificato non valido per l'indirizzo");
            DataOutputStream o = new DataOutputStream(s.getOutputStream());
            o.writeShort(q.length);
            o.write(q);
            o.flush();
            DataInputStream in = new DataInputStream(s.getInputStream());
            byte[] m = new byte[in.readUnsignedShort()];
            in.readFully(m);
            return m;
        } catch (GeneralSecurityException e) {
            throw new IOException(e);
        }
    }

    /** Domanda DNS di tipo A, id 0 (come chiede RFC 8484), ricorsione richiesta. */
    static byte[] query(String host) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(new byte[] {0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0});
        for (String l : host.split("\\.")) {
            byte[] p = l.getBytes(StandardCharsets.US_ASCII);
            if (p.length == 0 || p.length > 63) throw new IOException("nome non valido");
            b.write(p.length);
            b.write(p);
        }
        b.write(new byte[] {0, 0, 1, 0, 1});
        return b.toByteArray();
    }

    /** Tutti i record A della risposta (anche dopo un CNAME); in ttl[0] il TTL più basso. */
    static List<InetAddress> parse(byte[] m, long[] ttl) throws IOException {
        try {
            if ((m[3] & 0x0f) != 0) throw new IOException("DNS: errore " + (m[3] & 0x0f));
            int qd = u16(m, 4), an = u16(m, 6), p = 12;
            for (int i = 0; i < qd; i++) p = skipName(m, p) + 4;
            List<InetAddress> r = new ArrayList<>();
            for (int i = 0; i < an; i++) {
                p = skipName(m, p);
                int type = u16(m, p), len = u16(m, p + 8);
                long t = ((long) u16(m, p + 4) << 16) | u16(m, p + 6);
                p += 10;
                if (type == 1 && len == 4) {
                    r.add(Inet4Address.getByAddress(Arrays.copyOfRange(m, p, p + 4)));
                    ttl[0] = Math.min(ttl[0], t);
                }
                p += len;
            }
            return r;
        } catch (ArrayIndexOutOfBoundsException e) {
            throw new IOException("DNS: risposta troncata");
        }
    }

    private static int u16(byte[] m, int p) { return (m[p] & 0xff) << 8 | (m[p + 1] & 0xff); }

    private static int skipName(byte[] m, int p) {
        while (true) {
            int l = m[p] & 0xff;
            if (l == 0) return p + 1;
            if ((l & 0xc0) == 0xc0) return p + 2;
            p += l + 1;
        }
    }
}
