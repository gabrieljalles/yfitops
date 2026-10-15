package dev.yfitops.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
        receiveShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receiveShare(intent);
    }

    /**
     * Link compartilhado pelo menu "Compartilhar" (YouTube, Spotify...): abre a
     * tela de envio com o link no campo (o site lê ?share_text=, ver main.tsx).
     */
    private void receiveShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        setIntent(new Intent());
        if (text == null || text.isEmpty() || getBridge() == null) return;
        String base = getBridge().getServerUrl();
        if (base == null) return;
        String url = base.replaceAll("/+$", "") + "/?share_text=" + URLEncoder.encode(text, StandardCharsets.UTF_8);
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
