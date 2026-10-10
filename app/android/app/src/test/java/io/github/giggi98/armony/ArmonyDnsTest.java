package io.github.giggi98.armony;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Prove del DNS di riserva sul PC: ./gradlew testDebugUnitTest
 * Quelle in rete (DoH reale e un GET all'API pubblica /api/info di un server Armony attraverso il proxy)
 * partono solo con ARMONY_TEST_RETE=https://nome.del.server:porta
 */
public class ArmonyDnsTest {
    private static final String RETE = System.getenv("ARMONY_TEST_RETE");

    @Test
    public void domandaERisposta() throws Exception {
        byte[] q = ArmonyDns.query("a.b.example");
        // risposta: la domanda, un CNAME (nome compresso) e un A con TTL 120
        byte[] head = {0, 0, (byte) 0x81, (byte) 0x80, 0, 1, 0, 2, 0, 0, 0, 0};
        byte[] cname = {(byte) 0xc0, 12, 0, 5, 0, 1, 0, 0, 1, 0, 0, 4, 1, 'x', (byte) 0xc0, 12};
        byte[] a = {(byte) 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 10, 1, 2, 3};
        byte[] m = new byte[q.length + cname.length + a.length];
        System.arraycopy(q, 0, m, 0, q.length);
        System.arraycopy(head, 0, m, 0, head.length);
        System.arraycopy(cname, 0, m, q.length, cname.length);
        System.arraycopy(a, 0, m, q.length + cname.length, a.length);
        long[] ttl = {3600};
        List<InetAddress> r = ArmonyDns.parse(m, ttl);
        assertEquals(Arrays.asList(InetAddress.getByName("10.1.2.3")), r);
        assertEquals(120, ttl[0]);
    }

    @Test
    public void soloHostConsentiti() {
        ArmonyDns d = new ArmonyDns();
        d.setHosts(Arrays.asList("Casa.example.net:10000", "altro.example.net"));
        assertTrue(d.allowed("casa.example.net", 10000));
        assertFalse(d.allowed("casa.example.net", 22));
        assertTrue(d.allowed("altro.example.net", 443));
        assertTrue(d.allowed("objects.githubusercontent.com", 443));
        assertFalse(d.allowed("example.com", 443));
        assertTrue(d.rules().contains("casa.example.net:10000"));
        assertTrue(d.rules().contains("altro.example.net:443"));
    }

    @Test
    public void dohReale() throws Exception {
        assumeTrue(RETE != null);
        String host = new URL(RETE).getHost();
        for (String via : new String[] {"cloudflare", "google", "quad9"}) {
            ArmonyDns d = new ArmonyDns();
            d.via = via;
            List<InetAddress> r = d.doh(host);
            System.out.println(via + ": " + r);
            assertFalse(r.isEmpty());
        }
    }

    @Test
    public void proxyReale() throws Exception {
        assumeTrue(RETE != null);
        URL u = new URL(RETE + "/api/info");
        ArmonyDns d = new ArmonyDns();
        d.system = false;  // come con il DNS del telefono che non trova il nome: passa solo dal DoH
        d.setHosts(Arrays.asList(u.getHost() + ":" + u.getPort()));
        int port = d.start();
        try {
            HttpURLConnection c = (HttpURLConnection) u.openConnection(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port)));
            assertEquals(200, c.getResponseCode());
            String body;
            try (InputStream in = c.getInputStream()) { body = new String(in.readAllBytes(), StandardCharsets.UTF_8); }
            System.out.println("api/info via proxy: " + body.substring(0, Math.min(80, body.length())));
            assertTrue(body.contains("\"armony\":true"));
            // host non configurato e porta non consentita: rifiutati
            assertTrue(connect(port, "example.com:443").startsWith("HTTP/1.1 403"));
            assertTrue(connect(port, u.getHost() + ":22").startsWith("HTTP/1.1 403"));
        } finally { d.stop(); }
    }

    private static String connect(int port, String target) throws Exception {
        try (Socket s = new Socket("127.0.0.1", port)) {
            OutputStream o = s.getOutputStream();
            o.write(("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            byte[] b = new byte[64];
            int n = s.getInputStream().read(b);
            return new String(b, 0, Math.max(0, n), StandardCharsets.ISO_8859_1);
        }
    }
}
