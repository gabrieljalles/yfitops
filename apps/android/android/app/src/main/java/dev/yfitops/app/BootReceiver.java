package dev.yfitops.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Celular ajudante: o celular acabou de ligar (ou o app acabou de ser atualizado).
 * Abre o app sozinho; a página liga o ajudante de novo ao carregar.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Helper.isOn(ctx)) Helper.launch(ctx);
    }
}
