package io.github.giggi98.armony;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Notifiche ad app chiusa. Ogni 15 minuti (il minimo di Android, solo con la rete; in risparmio energetico Android
 * può raggruppare le esecuzioni) chiede al server le notifiche non lette nuove (/api/notifiche/nuove, con un gettone
 * che vale solo lì e muore con la revoca del dispositivo) e le mostra nel canale «Avvisi».
 * Niente servizi push esterni (DECISIONS): costa una richiesta piccola ogni 15 minuti.
 */
public class ArmonyNotificheWorker extends Worker {
    static final String PREFS = "armony_notifiche", WORK = "armony-notifiche";

    public ArmonyNotificheWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c) {
        PeriodicWorkRequest w = new PeriodicWorkRequest.Builder(ArmonyNotificheWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, w);
    }

    static void cancel(Context c) { WorkManager.getInstance(c).cancelUniqueWork(WORK); }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = p.getString("url", ""), token = p.getString("token", "");
        if (!p.getBoolean("on", false) || url.isEmpty() || token.isEmpty()) return Result.success();
        // con l'app in primo piano le notifiche le mostra l'app stessa, dentro l'app
        if (MainActivity.visible) return Result.success();
        long last = p.getLong("last", 0);
        List<String> kinds = Arrays.asList(p.getString("kinds", "").split(","));
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(url.replaceAll("/+$", "") + "/api/notifiche/nuove?dopo=" + last).openConnection();
            h.setConnectTimeout(15000); h.setReadTimeout(15000);
            h.setRequestProperty("X-Notifiche", token);
            int code = h.getResponseCode();
            if (code == 401) { p.edit().putBoolean("on", false).apply(); return Result.success(); }  // dispositivo revocato
            if (code != 200) return Result.success();
            InputStream in = h.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b = new byte[8192];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            JSONArray items = new JSONObject(out.toString("UTF-8")).optJSONArray("items");
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject x = items.getJSONObject(i);
                long id = x.getLong("id");
                last = Math.max(last, id);
                String k = x.optString("kind");
                if (!k.equals("sistema") && !kinds.contains(k)) continue;
                try {
                    ArmonyFilesPlugin.post(c, (int) id, x.optString("title", "Armony"), x.optString("body", ""), x.optString("link", ""));
                } catch (SecurityException e) {
                    break;  // notifiche non consentite: si riprova la volta dopo
                }
            }
            p.edit().putLong("last", last).apply();
        } catch (Exception e) {
            // rete o server giù: si riprova al giro dopo
        } finally {
            if (h != null) h.disconnect();
        }
        return Result.success();
    }
}
