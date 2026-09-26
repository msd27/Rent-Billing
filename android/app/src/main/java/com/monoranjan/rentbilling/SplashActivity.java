package com.monoranjan.rentbilling;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

// The launcher activity: plays the particle/neon-pulse splash animation
// (SplashView) once, then hands off to MainActivity. Kept as a separate
// plain Activity rather than folded into MainActivity so MainActivity's
// own theme/lifecycle (WebView, Capacitor bridge) stays untouched by the
// splash — this screen never loads any of that.
public class SplashActivity extends Activity {
    private SplashView splashView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        splashView = new SplashView(this);
        splashView.setOnFinishedListener(this::goToMain);
        setContentView(splashView);
        splashView.start();
    }

    private void goToMain() {
        if (isFinishing()) {
            return;
        }
        startActivity(new Intent(this, MainActivity.class));
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        finish();
    }

    @Override
    protected void onDestroy() {
        splashView.stop();
        super.onDestroy();
    }
}
