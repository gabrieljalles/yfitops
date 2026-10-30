package dev.yfitops.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.net.Uri;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Mantém o app vivo enquanto toca (com a tela desligada) e segura o Wi-Fi e o
 * processador acordados durante um download da fila. Usado por native.ts.
 */
@CapacitorPlugin(name = "YfitopsKeepAlive")
public class KeepAlivePlugin extends Plugin {

    /** O serviço avisa por aqui quando a pessoa toca em "Pausar" na notificação. */
    static KeepAlivePlugin instance;

    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;
    private boolean askedNotifications = false;
    /** Celular ajudante ligado: Wi-Fi e processador acordados o tempo todo. */
    private boolean helper = false;
    /** Segundo plano (Wi-Fi e carregando): ajuda a fila com o app fechado na tela. */
    private boolean background = false;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void start(PluginCall call) {
        askNotifications();
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        intent.putExtra("title", call.getString("title", "Yfitops"));
        intent.putExtra("text", call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (Exception e) {
            // O sistema pode recusar (app em segundo plano): a música continua, só sem a garantia.
        }
        call.resolve();
    }

    /**
     * O que está tocando (para o carro, o fone, a tela bloqueada e a notificação).
     * Liga o serviço na primeira vez; depois só atualiza.
     */
    @PluginMethod
    public void media(PluginCall call) {
        String title = call.getString("title", "Yfitops");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", true));
        double position = call.getDouble("position", 0.0);
        double duration = call.getDouble("duration", 0.0);
        KeepAliveService service = KeepAliveService.instance;
        if (service != null) {
            new Handler(Looper.getMainLooper()).post(() -> service.update(title, artist, album, playing, position, duration));
        } else {
            askNotifications();
            Intent intent = new Intent(getContext(), KeepAliveService.class);
            intent.putExtra("title", title);
            intent.putExtra("artist", artist);
            intent.putExtra("album", album);
            intent.putExtra("playing", playing);
            intent.putExtra("position", position);
            intent.putExtra("duration", duration);
            try {
                ContextCompat.startForegroundService(getContext(), intent);
            } catch (Exception e) {
                // O sistema pode recusar (app em segundo plano): a música continua, só sem os controles.
            }
        }
        call.resolve();
    }

    /** Versão do app instalado (o site avisa quando há um APK mais novo para instalar). */
    @PluginMethod
    public void version(PluginCall call) {
        JSObject out = new JSObject();
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            out.put("build", PackageInfoCompat.getLongVersionCode(info));
        } catch (PackageManager.NameNotFoundException e) {
            out.put("build", 0);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        KeepAliveService service = KeepAliveService.instance;
        if (helper && service != null) new Handler(Looper.getMainLooper()).post(service::clearMedia);
        else getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        call.resolve();
    }

    /**
     * Celular ajudante (24 horas, desde o build 4): ajuda a fila mesmo sem música e
     * com a tela desligada. Segura o Wi-Fi e o processador acordados, mantém a página
     * com prioridade alta e pede para o Android não economizar bateria com o app.
     */
    @PluginMethod
    public void helper(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        helper = on;
        Helper.set(getContext(), on);
        Intent intent = new Intent(getContext(), KeepAliveService.class).putExtra("helper", on);
        try {
            if (on) {
                askNotifications();
                ContextCompat.startForegroundService(getContext(), intent);
            } else if (KeepAliveService.instance != null) {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            // O sistema pode recusar (app em segundo plano): tenta de novo quando o app abrir.
        }
        lock(on || background, 0);
        boolean keep = on || background;
        WebView web = getBridge().getWebView();
        if (Build.VERSION.SDK_INT >= 26) web.post(() -> web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !keep));
        // Bateria sem economia e "aparecer sobre outros apps" (para abrir sozinho).
        if (on) Helper.askMissing(getContext());
        call.resolve();
    }

    /**
     * Segundo plano (desde o build 6): no Wi-Fi e carregando, o app segue ajudando a
     * fila com a tela desligada e sem música. Mesmo serviço da música, com uma
     * notificação discreta; não abre sozinho (isso é só do celular ajudante).
     */
    @PluginMethod
    public void background(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (on == background) {
            call.resolve();
            return;
        }
        background = on;
        Intent intent = new Intent(getContext(), KeepAliveService.class).putExtra("background", on);
        try {
            if (on) ContextCompat.startForegroundService(getContext(), intent);
            else if (KeepAliveService.instance != null) getContext().startService(intent);
        } catch (Exception e) {
            // O sistema pode recusar (app já no fundo e sem a permissão de bateria).
        }
        if (!helper) lock(on, 0);
        WebView web = getBridge().getWebView();
        if (Build.VERSION.SDK_INT >= 26 && !helper) web.post(() -> web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !on));
        call.resolve();
    }

    /** A pessoa já deixou o app funcionar em segundo plano (bateria sem restrição)? */
    @PluginMethod
    public void backgroundAllowed(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject out = new JSObject();
        out.put("allowed", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(out);
    }

    /** Pede as notificações e a bateria sem restrição (a tela do próprio Android). */
    @PluginMethod
    public void allowBackground(PluginCall call) {
        askNotifications();
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (!pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(i);
            } catch (Exception e) {
                // Alguns celulares não têm essa tela: segue sem.
            }
        }
        call.resolve();
    }

    /** Download da fila em andamento: Wi-Fi e processador acordados (no máximo 15 min por vez). */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void busy(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        // No modo ajudante e em segundo plano os dois já ficam acordados o tempo todo.
        if (!helper && !background) lock(on, 15 * 60 * 1000L);
        call.resolve();
    }

    /** Wi-Fi e processador acordados (timeout 0 = até desligar). */
    @SuppressWarnings("deprecation")
    private void lock(boolean on, long timeout) {
        Context ctx = getContext().getApplicationContext();
        if (on) {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yfitops:download");
                wakeLock.setReferenceCounted(false);
            }
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "yfitops:download");
                wifiLock.setReferenceCounted(false);
            }
            if (timeout > 0) wakeLock.acquire(timeout);
            else wakeLock.acquire();
            wifiLock.acquire();
        } else {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        }
    }

    void emitAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("action", data);
    }

    /** Android 13+: a notificação "Tocando" (com o botão de pausar) precisa de permissão. Pede uma vez. */
    private void askNotifications() {
        if (Build.VERSION.SDK_INT < 33 || askedNotifications || getActivity() == null) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        askedNotifications = true;
        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4242);
    }

    @Override
    protected void handleOnDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (instance == this) instance = null;
    }
}
