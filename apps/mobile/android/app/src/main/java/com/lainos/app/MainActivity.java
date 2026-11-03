package com.lainos.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The hosted chat in a WebView (Capacitor), plus the one thing a web page cannot
 * be: a target of Android's share sheet. Text or a link shared from any app opens
 * a new chat with Lain with it already typed (`?prompt=`), and is never sent by
 * itself — the person reads it and presses send.
 */
public class MainActivity extends BridgeActivity {

    private static final int MAX_PROMPT = 4000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        openShared(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openShared(intent);
    }

    private void openShared(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || getBridge() == null) {
            return;
        }

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) {
            return;
        }

        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String prompt = subject != null && !subject.trim().isEmpty() && !text.contains(subject)
            ? subject.trim() + "\n" + text.trim()
            : text.trim();
        if (prompt.length() > MAX_PROMPT) {
            prompt = prompt.substring(0, MAX_PROMPT);
        }

        final String url = getString(R.string.share_url) + Uri.encode(prompt);
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
        // Consumed: a rotation or a return to the app must not open it twice.
        setIntent(new Intent(Intent.ACTION_MAIN));
    }
}
