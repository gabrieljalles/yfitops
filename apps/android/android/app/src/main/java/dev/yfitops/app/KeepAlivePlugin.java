package dev.yfitops.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
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

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        call.resolve();
    }

    /** Download da fila em andamento: Wi-Fi e processador acordados (no máximo 15 min por vez). */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void busy(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
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
            wakeLock.acquire(15 * 60 * 1000L);
            wifiLock.acquire();
        } else {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        }
        call.resolve();
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
