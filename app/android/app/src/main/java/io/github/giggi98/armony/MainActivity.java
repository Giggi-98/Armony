package io.github.giggi98.armony;

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
        super.onCreate(savedInstanceState);
        // audio e copertine della musica del telefono all'indirizzo dell'app (/_armony_/…), il resto come prima
        bridge.setWebViewClient(new ArmonyLibraryPlugin.Web(bridge));
    }
}
