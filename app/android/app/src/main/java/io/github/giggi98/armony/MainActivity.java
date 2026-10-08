package io.github.giggi98.armony;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // plugin locali: vanno registrati prima di super.onCreate
        registerPlugin(ArmonyMediaPlugin.class);
        registerPlugin(ArmonyUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
