package dev.yfitops.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Serviço "tocando música": enquanto ele existe, o Android não fecha o app com
 * a tela desligada. A notificação abre o app e tem o botão "Pausar".
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL = "playback";
    private static final int ID = 1;
    private static final String PAUSE = "dev.yfitops.app.PAUSE";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && PAUSE.equals(intent.getAction())) {
            if (KeepAlivePlugin.instance != null) KeepAlivePlugin.instance.emitAction("pause");
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Música tocando", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        String title = intent != null ? intent.getStringExtra("title") : null;
        String text = intent != null ? intent.getStringExtra("text") : null;
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent pause = new Intent(this, KeepAliveService.class).setAction(PAUSE);
        PendingIntent pausePi = PendingIntent.getService(this, 1, pause, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_vinyl)
            .setContentTitle(title == null || title.isEmpty() ? "Yfitops" : title)
            .setContentText(text == null ? "" : text)
            .setContentIntent(openPi)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, "Pausar", pausePi)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(ID, n);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
