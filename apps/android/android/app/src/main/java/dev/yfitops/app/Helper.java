package dev.yfitops.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

/**
 * Celular ajudante (24 horas). A escolha fica guardada aqui também (o site guarda a
 * dele), porque quem abre o app sozinho, depois de o celular ligar ou de o Android
 * fechar o app, é a parte nativa, antes de a página carregar.
 */
final class Helper {

    private static final String PREFS = "yfitops";
    private static final String KEY = "helper";

    private Helper() {}

    static boolean isOn(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false);
    }

    static void set(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply();
    }

    /**
     * Abre o app. Com ele fechado, o Android só deixa abrir sozinho se o app tiver a
     * permissão "aparecer sobre outros apps" (pedida ao ligar o modo ajudante).
     */
    static void launch(Context ctx) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) return;
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(open);
        } catch (Exception e) {
            // Sem a permissão: fica para quando alguém abrir o app.
        }
    }

    /**
     * O que ainda falta liberar para o app ficar sempre ligado: uma tela de
     * configurações por vez (a próxima vem quando o app abrir de novo).
     */
    static void askMissing(Context ctx) {
        Intent i = null;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (!pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
            i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
        } else if (Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(ctx)) {
            i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
        }
        if (i == null) return;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            // Alguns celulares não têm essa tela: segue sem.
        }
    }
}
