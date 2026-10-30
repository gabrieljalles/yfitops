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
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;

/**
 * Serviço "tocando música": enquanto ele existe, o Android não fecha o app com
 * a tela desligada. Ele também registra o Yfitops como o player de música do
 * celular (MediaSession): é por ela que o carro, o fone Bluetooth, a tela
 * bloqueada e a notificação mandam "próxima", "anterior", "pausar" e "pular para".
 * Sem ela, o Android mandava esses botões para outro app de música.
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL = "playback";
    private static final int ID = 1;
    private static final String PAUSE = "dev.yfitops.app.PAUSE";
    private static final String TOGGLE = "dev.yfitops.app.TOGGLE";
    private static final String NEXT = "dev.yfitops.app.NEXT";
    private static final String PREV = "dev.yfitops.app.PREV";

    /** O plugin atualiza o que está tocando direto por aqui (o serviço já está rodando). */
    static KeepAliveService instance;

    private MediaSessionCompat session;
    private String title = "Yfitops";
    private String artist = "";
    private String album = "";
    private boolean playing = true;
    private long positionMs = 0;
    private long durationMs = 0;
    /** Celular ajudante (24 horas): o serviço fica ligado mesmo sem música. */
    private boolean helper = false;
    /** Segundo plano (Wi-Fi e carregando): o serviço fica ligado mesmo sem música, sem abrir sozinho. */
    private boolean background = false;
    /** Tem música na fila (senão, no modo ajudante, a notificação diz "ajudando"). */
    private boolean media = false;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // O Android pode recriar o serviço sozinho (depois de fechar o app por falta de memória).
        helper = Helper.isOn(this);
        session = new MediaSessionCompat(this, "Yfitops");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                emit("play");
            }

            @Override
            public void onPause() {
                emit("pause");
            }

            @Override
            public void onStop() {
                emit("pause");
            }

            @Override
            public void onSkipToNext() {
                emit("next");
            }

            @Override
            public void onSkipToPrevious() {
                emit("prev");
            }

            @Override
            public void onSeekTo(long pos) {
                emit("seek:" + (pos / 1000.0));
            }
        });
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            session.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (PAUSE.equals(action)) {
            emit("pause");
            return START_NOT_STICKY;
        }
        if (TOGGLE.equals(action)) {
            emit(playing ? "pause" : "play");
            return START_NOT_STICKY;
        }
        if (NEXT.equals(action)) {
            emit("next");
            return START_NOT_STICKY;
        }
        if (PREV.equals(action)) {
            emit("prev");
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Música tocando", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        if (intent == null && helper) {
            // Recriado pelo Android: o app tinha sido fechado. Abre de novo (a página religa o ajudante).
            Helper.launch(this);
        }
        if (intent != null && intent.hasExtra("helper")) {
            // Liga ou desliga o modo ajudante; a música (se houver) continua como está.
            helper = intent.getBooleanExtra("helper", false);
            if (!helper && !media && !background) {
                shutdown();
                return START_NOT_STICKY;
            }
        } else if (intent != null && intent.hasExtra("background")) {
            background = intent.getBooleanExtra("background", false);
            if (!helper && !media && !background) {
                shutdown();
                return START_NOT_STICKY;
            }
        } else if (intent != null) {
            media = true;
            String t = intent.getStringExtra("title");
            if (t != null && !t.isEmpty()) title = t;
            // Apps antigos mandavam o artista como "text".
            String a = intent.hasExtra("artist") ? intent.getStringExtra("artist") : intent.getStringExtra("text");
            artist = a == null ? "" : a;
            String al = intent.getStringExtra("album");
            album = al == null ? "" : al;
            playing = intent.getBooleanExtra("playing", true);
            positionMs = Math.round(intent.getDoubleExtra("position", 0) * 1000);
            durationMs = Math.round(intent.getDoubleExtra("duration", 0) * 1000);
        }
        applySession();
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(ID, n);
        // Celular ajudante: se o Android fechar o serviço, ele mesmo o recria.
        return helper ? START_STICKY : START_NOT_STICKY;
    }

    /** Música, tocando/pausada e posição (segundos), vindos do app. */
    void update(String title, String artist, String album, boolean playing, double position, double duration) {
        this.media = true;
        this.title = title == null || title.isEmpty() ? "Yfitops" : title;
        this.artist = artist == null ? "" : artist;
        this.album = album == null ? "" : album;
        this.playing = playing;
        this.positionMs = Math.round(position * 1000);
        this.durationMs = Math.round(duration * 1000);
        applySession();
        getSystemService(NotificationManager.class).notify(ID, buildNotification());
    }

    /**
     * A música parou de vez. No modo ajudante o serviço continua (com a notificação
     * "ajudando"); senão, sai tudo.
     */
    void clearMedia() {
        media = false;
        if (!helper && !background) {
            shutdown();
            return;
        }
        applySession();
        getSystemService(NotificationManager.class).notify(ID, buildNotification());
    }

    private void applySession() {
        // Sem música, o Yfitops não se apresenta como player (o carro não o mostra).
        session.setActive(media);
        if (!media) return;
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
            .build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_STOP)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());
    }

    private PendingIntent action(String name, int code) {
        Intent i = new Intent(this, KeepAliveService.class).setAction(name);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        if (!media && !helper) {
            // Segundo plano: discreta, só o nome do app.
            return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_vinyl)
                .setContentTitle("Yfitops")
                .setContentIntent(openPi)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
        }
        if (!media) {
            return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_vinyl)
                .setContentTitle("Celular ajudante")
                .setContentText("Baixando as músicas pedidas, 24 horas")
                .setContentIntent(openPi)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
        }
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_vinyl)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(openPi)
            .setOngoing(playing)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Anterior", action(PREV, 2))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pausar" : "Tocar", action(TOGGLE, 3))
            .addAction(android.R.drawable.ic_media_next, "Próxima", action(NEXT, 4))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    private void emit(String action) {
        if (KeepAlivePlugin.instance != null) KeepAlivePlugin.instance.emitAction(action);
    }

    /**
     * A pessoa fechou o app (arrastou para fora da lista de recentes): a música já
     * parou junto com a tela, então a notificação e os controles do carro saem também.
     * Sem isso, a notificação ficava "tocando" para sempre.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Celular ajudante: abre de novo (para desligar, é a chave em Ajustes).
        if (helper) Helper.launch(this);
        else shutdown();
        super.onTaskRemoved(rootIntent);
    }

    /** Tira a notificação e para o serviço. */
    void shutdown() {
        if (session != null) session.setActive(false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        getSystemService(NotificationManager.class).cancel(ID);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        getSystemService(NotificationManager.class).cancel(ID);
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
