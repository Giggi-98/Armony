package io.github.giggi98.armony;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ArmonyMediaPlugin.class);  // plugin locale: va registrato prima di super.onCreate
        super.onCreate(savedInstanceState);
    }
}
