package io.github.giggi98.armony;

import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Quanto le barre di sistema e la tastiera coprono davvero la WebView, in px CSS.
 *   get()  e evento "insets" (trattenuto): { top, bottom, left, right, kb, ime }
 * Molte WebView danno env(safe-area-inset-bottom) = 0 anche quando la barra dei gesti o dei tasti sta sopra
 * la pagina. Si misura la sovrapposizione fra le barre (insets della finestra, intatti) e la posizione della
 * WebView: se SystemBars di Capacitor ha già rimpicciolito la WebView, la sovrapposizione è 0 e il CSS non
 * aggiunge niente due volte. Il listener sta sul genitore della WebView e restituisce gli insets com'erano,
 * così quello di Capacitor (sulla DecorView) resta il solo a decidere.
 */
@CapacitorPlugin(name = "ArmonyInsets")
public class ArmonyInsetsPlugin extends Plugin {
    private JSObject last = new JSObject();

    @Override
    public void load() {
        WebView wv = getBridge().getWebView();
        if (wv.getParent() instanceof View parent) ViewCompat.setOnApplyWindowInsetsListener(parent, (v, insets) -> {
            v.post(this::measure);
            return ViewCompat.onApplyWindowInsets(v, insets);
        });
        wv.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> v.post(this::measure));
        wv.post(this::measure);
    }

    @PluginMethod
    public void get(PluginCall call) {
        call.resolve(last);
    }

    private void measure() {
        WebView wv = getBridge().getWebView();
        WindowInsetsCompat w = ViewCompat.getRootWindowInsets(wv);
        if (w == null || wv.getHeight() == 0) return;
        Insets bars = w.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets ime = w.getInsets(WindowInsetsCompat.Type.ime());
        View root = wv.getRootView();
        int[] p = new int[2];
        wv.getLocationInWindow(p);
        int top = p[1], left = p[0];
        int bottom = root.getHeight() - (p[1] + wv.getHeight()), right = root.getWidth() - (p[0] + wv.getWidth());
        float d = getContext().getResources().getDisplayMetrics().density;
        JSObject o = new JSObject();
        o.put("top", Math.round(Math.max(0, bars.top - top) / d));
        o.put("bottom", Math.round(Math.max(0, bars.bottom - bottom) / d));
        o.put("left", Math.round(Math.max(0, bars.left - left) / d));
        o.put("right", Math.round(Math.max(0, bars.right - right) / d));
        o.put("kb", Math.round(Math.max(0, ime.bottom - bottom) / d));
        o.put("ime", w.isVisible(WindowInsetsCompat.Type.ime()));
        if (o.toString().equals(last.toString())) return;
        last = o;
        notifyListeners("insets", o, true);
    }
}
