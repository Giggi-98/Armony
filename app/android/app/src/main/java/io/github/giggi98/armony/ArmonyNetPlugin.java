package io.github.giggi98.armony;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;

/**
 * DNS di riserva: se il DNS del telefono (per esempio un "DNS privato" che filtra) non trova il
 * server, l'app lo risolve con un DNS pubblico via HTTPS. La WebView usa sempre il risolutore di
 * sistema, quindi il suo traffico HTTPS verso i server di Armony (e GitHub) passa da un proxy
 * locale (ArmonyDns) impostato con ProxyController; le richieste native passano da open().
 *   get()                          → { supported, on, via }
 *   set({ on?, via?, hosts? })     → come get(); hosts = ["host" | "host:porta"] dei server
 * Le scelte restano nelle preferenze dell'app: all'avvio il proxy è acceso prima del client.
 *
 * ─── PERCHÉ un proxy e non altro ───
 * shouldInterceptRequest non vede il corpo delle POST/PUT; CapacitorHttp non permette di scegliere
 * il DNS; l'IP del Funnel di Tailscale cambia. Il proxy vede solo CONNECT host:porta e copia byte
 * cifrati: il TLS resta da capo a capo.
 *
 * ─── SICUREZZA ───
 * Ascolta solo su 127.0.0.1, porta casuale, e apre tunnel solo verso host e porte dei server
 * configurati (più GitHub sulla 443): non è un proxy aperto. Un'altra app del telefono potrebbe
 * comunque collegarsi alla porta, ma otterrebbe solo un tunnel cifrato verso quei server, che
 * raggiunge già da sola. Un segreto in Proxy-Authorization non si può dare alla WebView
 * (ProxyConfig non ha credenziali) e il controllo dell'UID su una connessione locale da Android 10
 * è riservato alle app VPN.
 */
@CapacitorPlugin(name = "ArmonyNet")
public class ArmonyNetPlugin extends Plugin {
    static final ArmonyDns DNS = new ArmonyDns();
    private static SharedPreferences prefs;

    /** La WebView sa usare un proxy solo per alcuni host? (Android System WebView aggiornata) */
    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
            && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS);
    }

    /** All'avvio dell'app (MainActivity), prima che il client faccia richieste. */
    static synchronized void init(Context ctx) {
        if (prefs != null) return;
        prefs = ctx.getApplicationContext().getSharedPreferences("armony_net", Context.MODE_PRIVATE);
        DNS.via = prefs.getString("via", "cloudflare");
        DNS.setHosts(prefs.getStringSet("hosts", new HashSet<>()));
        apply();
    }

    /** Accende o spegne proxy e regole della WebView secondo le preferenze. */
    private static synchronized void apply() {
        boolean on = prefs.getBoolean("on", true) && supported();
        int port = 0;
        if (on) {
            try { port = DNS.start(); } catch (IOException e) { on = false; }
        }
        if (!on) DNS.stop();
        final int p = port;
        final boolean enable = on;
        // ProxyController vuole il thread principale
        new Handler(Looper.getMainLooper()).post(() -> {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return;
            if (!enable) { ProxyController.getInstance().clearProxyOverride(Runnable::run, () -> {}); return; }
            // con il bypass rovesciato le regole elencano gli host che PASSANO dal proxy; il resto va diretto.
            // Solo HTTPS; se il proxy non risponde la WebView prova la via diretta (addDirect)
            ProxyConfig.Builder b = new ProxyConfig.Builder()
                .addProxyRule("127.0.0.1:" + p, ProxyConfig.MATCH_HTTPS)
                .addDirect(ProxyConfig.MATCH_HTTPS)
                .setReverseBypassEnabled(true);
            for (String r : DNS.rules()) b.addBypassRule(r);
            ProxyController.getInstance().setProxyOverride(b.build(), Runnable::run, () -> {});
        });
    }

    /** Connessione per le richieste native verso i server: dal proxy se è acceso e l'host è suo. */
    static HttpURLConnection open(String url) throws IOException {
        URL u = new URL(url);
        int port = DNS.port();
        if (port > 0 && "https".equals(u.getProtocol()) && DNS.allowed(u.getHost(), u.getPort() < 0 ? 443 : u.getPort()))
            return (HttpURLConnection) u.openConnection(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port)));
        return (HttpURLConnection) u.openConnection();
    }

    @Override
    public void load() {
        init(getContext());
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", supported());
        r.put("on", prefs.getBoolean("on", true));
        r.put("via", prefs.getString("via", "cloudflare"));
        call.resolve(r);
    }

    @PluginMethod
    public void set(PluginCall call) {
        SharedPreferences.Editor e = prefs.edit();
        if (call.hasOption("on")) e.putBoolean("on", Boolean.TRUE.equals(call.getBoolean("on")));
        String via = call.getString("via");
        if (via != null && via.matches("cloudflare|google|quad9")) { e.putString("via", via); DNS.via = via; }
        JSArray hosts = call.getArray("hosts");
        if (hosts != null) {
            Set<String> s = new HashSet<>();
            try { for (Object h : hosts.toList()) if (h instanceof String && ((String) h).matches("[A-Za-z0-9.-]+(:\\d+)?")) s.add((String) h); }
            catch (Exception ignored) {}
            e.putStringSet("hosts", s);
            DNS.setHosts(s);
        }
        e.apply();
        apply();
        get(call);
    }
}
