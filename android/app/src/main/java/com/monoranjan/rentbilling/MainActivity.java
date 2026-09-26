package com.monoranjan.rentbilling;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must run before super.onCreate() — this is what actually makes
        // AppTheme.NoActionBarLaunch's windowSplashScreenAnimatedIcon play;
        // the core-splashscreen dependency was already declared but never
        // installed, so the theme's splash attributes had no effect.
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
    }
}
