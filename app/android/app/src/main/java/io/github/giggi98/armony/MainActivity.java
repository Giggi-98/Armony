package io.github.giggi98.armony;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // plugin locali: vanno registrati prima di super.onCreate
        registerPlugin(ArmonyMediaPlugin.class);
        registerPlugin(ArmonyUpdatePlugin.class);
        registerPlugin(ArmonyInsetsPlugin.class);
        registerPlugin(ArmonyLibraryPlugin.class);
        registerPlugin(ArmonyNetPlugin.class);
        registerPlugin(ArmonyFilesPlugin.class);
        // app aperta toccando una notifica: il client ci va appena pronto (ArmonyFiles.pending)
        ArmonyFilesPlugin.pending = ArmonyFilesPlugin.linkOf(getIntent());
        // DNS di riserva: il proxy locale è pronto prima che il client chiami i server
        ArmonyNetPlugin.init(this);
        super.onCreate(savedInstanceState);
        // audio e copertine della musica del telefono all'indirizzo dell'app (/_armony_/…), il resto come prima
        bridge.setWebViewClient(new ArmonyLibraryPlugin.Web(bridge));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // tocco sulla copertina del widget con l'app già aperta: il client va su "In riproduzione"
        if (bridge != null && intent != null && intent.getBooleanExtra(ArmonyWidget.EXTRA_NOW, false))
            bridge.getWebView().evaluateJavascript("location.hash='#/ora'", null);
        // tocco su una notifica con l'app già aperta: il suo indirizzo (solo #/…, controllato in linkOf)
        String link = ArmonyFilesPlugin.linkOf(intent);
        if (bridge != null && link != null) bridge.getWebView().evaluateJavascript("location.hash=" + org.json.JSONObject.quote(link), null);
    }
}
