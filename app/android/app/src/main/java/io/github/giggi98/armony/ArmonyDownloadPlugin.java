package io.github.giggi98.armony;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Scaricare sul telefono, senza server (client/telefono.js, Local.dl):
 *   cerca({ q, n })            { brani: [{ url, titolo, artista, durata, copertina }] }  YouTube Music, poi i video
 *   scarica({ link } | { brano })  { aggiunti }   un link (brano o playlist) o un brano scelto dalla ricerca
 *   lavori()                   { lavori: [{ id, titolo, artista, album, stato, progresso, errore }] }
 *   pulisci()                  toglie dall'elenco i lavori finiti
 *   evento "lavoro"            un lavoro è cambiato (stato o avanzamento, al più due volte al secondo)
 * Prima di Android 10 serve il permesso di scrittura (la cartella Music): lo chiede scarica la prima volta.
 */
@CapacitorPlugin(
    name = "ArmonyDownload",
    permissions = { @Permission(alias = "scrivi", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) }
)
public class ArmonyDownloadPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() { ArmonyDownloadService.plugin = this; }

    @Override
    protected void handleOnDestroy() {
        if (ArmonyDownloadService.plugin == this) ArmonyDownloadService.plugin = null;
        io.shutdownNow();
    }

    void cambiato(JSONObject lavoro) {
        try { notifyListeners("lavoro", JSObject.fromJSONObject(lavoro)); } catch (Exception ignored) { }
    }

    @PluginMethod
    public void cerca(PluginCall call) {
        String q = call.getString("q", "").trim();
        int n = call.getInt("n", 10);
        if (q.isEmpty()) { call.reject("Scrivi cosa cercare"); return; }
        io.execute(() -> {
            try {
                JSArray a = new JSArray();
                for (Scaricatore.Brano b : Scaricatore.cerca(q, n)) a.put(b.json());
                JSObject r = new JSObject();
                r.put("brani", a);
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Ricerca non riuscita: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void scarica(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("scrivi") != PermissionState.GRANTED) {
            requestPermissionForAlias("scrivi", call, "permesso");
            return;
        }
        accoda(call);
    }

    @PermissionCallback
    private void permesso(PluginCall call) {
        if (getPermissionState("scrivi") != PermissionState.GRANTED) call.reject("Senza il permesso Armony non può salvare la musica sul telefono");
        else accoda(call);
    }

    private void accoda(PluginCall call) {
        JSObject brano = call.getObject("brano");
        String link = call.getString("link", "").trim();
        io.execute(() -> {
            try {
                List<Scaricatore.Brano> brani = new ArrayList<>();
                if (brano != null && brano.has("url")) brani.add(Scaricatore.Brano.da(brano));
                else if (link.startsWith("http")) {
                    for (String u : Scaricatore.brani(link)) { Scaricatore.Brano b = new Scaricatore.Brano(); b.url = u; brani.add(b); }
                } else { call.reject("Incolla un link di YouTube o YouTube Music"); return; }
                if (brani.isEmpty()) { call.reject("Nessun brano in questo link"); return; }
                ArmonyDownloadService.aggiungi(getContext(), brani);
                JSObject r = new JSObject();
                r.put("aggiunti", brani.size());
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Link non riconosciuto: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void lavori(PluginCall call) {
        JSONArray a = ArmonyDownloadService.elenco();
        JSArray out = new JSArray();
        for (int i = 0; i < a.length(); i++) {
            try { out.put(JSObject.fromJSONObject(a.getJSONObject(i))); } catch (Exception ignored) { }
        }
        JSObject r = new JSObject();
        r.put("lavori", out);
        call.resolve(r);
    }

    @PluginMethod
    public void pulisci(PluginCall call) {
        ArmonyDownloadService.pulisci();
        lavori(call);
    }
}
