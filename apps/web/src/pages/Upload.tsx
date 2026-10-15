import { useRef, useState } from "react";
import type { ImportRequestInfo, ImportTrackStatus } from "@yfitops/core";
import { Icon } from "../components/Icon";
import { confirmDialog } from "../lib/dialog";
import { clearFinished, enqueue, jobsStore } from "../lib/importer";
import { StorageBar } from "../components/StorageBar";
import { TagInput } from "../components/TagInput";
import {
  answerLinkAsk,
  answerLinkPick,
  dropRequest,
  finished,
  importsStore,
  isDeezerLink,
  isSpotifyLink,
  isYouTubeLink,
  requestLink,
  requestProgress,
  retryRequest,
  serviceName,
  setImportLink,
  setImportTags,
  skipTracks,
} from "../lib/imports";
import { isAndroidBrowser } from "../lib/native";
import { askNotifyPermission } from "../lib/notify";
import { useStore } from "../lib/observable";
import { spotStore } from "../lib/spot";
import { formatBytes } from "../lib/tracks";
import { openTrack } from "../lib/ui";

/** O embed do Spotify só entrega as 50 primeiras músicas de uma playlist. */
function SpotifyLimit() {
  return (
    <p className="small muted">
      O Spotify só deixa ler as <strong>50 primeiras músicas</strong> da playlist. Se ela tiver
      mais, o resto ficou de fora.
    </p>
  );
}

export function UploadPage() {
  const jobs = useStore(jobsStore);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Vem de um store (e não de useState) para sobreviver à troca de tela.
  const { link, sending, error: linkError, ask, pick, tags, requests } = useStore(importsStore);
  const asking = !!pick || ask;
  const cleared = jobs.some((j) =>
    ["pronto", "já existe", "erro"].includes(j.status),
  );
  const bigBatch = jobs.filter((j) => j.status === "na fila").length > 20;

  /** Serviço do link colado: muda a cor da borda, o ícone e a cor do botão. */
  const brand = isYouTubeLink(link)
    ? "youtube"
    : isSpotifyLink(link)
      ? "spotify"
      : isDeezerLink(link)
        ? "deezer"
        : null;

  return (
    <div className="page">
      <StorageBar onlyWhenFull />
      <div
        className={`dropzone${over ? " over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void askNotifyPermission();
          enqueue([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={32} />
        <strong>Solte suas músicas aqui</strong>
        <span className="muted small">
          ou toque para escolher · áudio em qualquer formato, e também vídeos (o
          app tira só o áudio)
        </span>
        <input
          ref={input}
          type="file"
          accept="audio/*,video/*,.flac,.wav,.w64,.aif,.aiff,.caf,.m4a,.opus,.ogg,.wv,.ape,.tta,.wma,.ac3,.dts,.mka,.dsf,.dff,.mkv"
          multiple
          hidden
          onChange={(e) => {
            void askNotifyPermission();
            enqueue([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      <div className={`link-import${brand ? ` linked ${brand}` : ""}`}>
        <label className="link-field">
          <span className="link-brand" aria-hidden="true">
            <Icon name={brand ?? "youtube"} size={20} />
          </span>
          <input
            type="url"
            value={link}
            placeholder="ou cole um link do YouTube, Spotify ou Deezer"
            disabled={sending || asking}
            onChange={(e) => setImportLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void requestLink()}
          />
        </label>
        <button className="primary" disabled={sending || asking || !link.trim()} onClick={() => void requestLink()}>
          {sending ? "pedindo..." : "pedir"}
        </button>
        {linkError && <span className="small err">{linkError}</span>}
      </div>

      <WifiHint />

      {/* Opcional: só aparece com um link válido (ou se já houver tags escolhidas). */}
      {(brand || tags.length > 0) && (
        <div className="import-tags">
          <span className="muted small">
            Tags para todas as músicas <span className="muted">(opcional)</span>
          </span>
          <TagInput tags={tags} onChange={setImportTags} placeholder="ex.: academia, anos-80…" disabled={sending} />
        </div>
      )}

      {pick && (
        <div className="import-result">
          <p>
            Esse link é de uma música dentro {pick.mix ? "de um " : "de uma "}
            <strong>{pick.mix ? "mix do YouTube" : "playlist"}</strong>. O que você quer baixar?
          </p>
          {pick.mix && (
            <p className="small muted">
              Mixes são montados pelo próprio YouTube a partir da música e costumam ter até 50 faixas.
            </p>
          )}
          <div className="import-result-actions">
            <button className="primary" onClick={() => answerLinkPick("one")}>
              só esta música
            </button>
            <button className="link" onClick={() => answerLinkPick("all")}>
              {pick.mix ? "o mix inteiro" : "a playlist inteira"}
            </button>
            <button className="chip ghost" onClick={() => answerLinkPick(null)}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {ask && (
        <div className="import-result">
          <p>
            Esse link é de uma <strong>playlist</strong> (ou álbum). Quer que as músicas fiquem ligadas a uma playlist no
            app, com o mesmo nome?
          </p>
          {isSpotifyLink(link) && <SpotifyLimit />}
          <div className="import-result-actions">
            <button className="primary" onClick={() => answerLinkAsk(true)}>
              pedir e criar a playlist
            </button>
            <button className="link" onClick={() => answerLinkAsk(false)}>
              só as músicas
            </button>
            <button className="chip ghost" onClick={() => answerLinkAsk(null)}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {requests.length > 0 && (
        <>
          <div className="section-head">
            <h2>Pedidos por link</h2>
          </div>
          <ul className="requests">
            {requests.map((r) => (
              <RequestCard key={r.id} r={r} />
            ))}
          </ul>
        </>
      )}

      <details className="explain">
        <summary>
          Quais formatos posso enviar e o que acontece com cada um
        </summary>
        <ul>
          <li>
            Tudo vira <strong>MP3 192 kbps</strong>: toca em qualquer aparelho e
            ocupa pouco (cerca de 6 MB por música de 4 minutos).
          </li>
          <li>
            <strong>MP3 de até 192 kbps</strong> fica como está (reconverter só
            pioraria). MP3 maior, AAC, Opus, OGG, WMA e outros são convertidos.
          </li>
          <li>
            <strong>Formatos sem perda</strong> (FLAC, WAV, AIFF, ALAC, DSD…)
            também viram MP3. Ficam bem menores, mas deixam de ser sem perda.
          </li>
          <li>
            <strong>Vídeos</strong> (MP4, MKV, WEBM, MOV…): o app usa só o áudio.
          </li>
          <li>
            <strong>A nuvem é compartilhada:</strong> se alguém já trouxe a mesma
            música (mesmo artista, título e duração), nada é enviado: ela só
            entra na sua biblioteca. As músicas ficam visíveis na busca de quem
            usa o app, mas ninguém vê a sua biblioteca, playlists ou favoritas.
          </li>
        </ul>
      </details>

      {bigBatch && (
        <p className="muted small">
          Lotes grandes demoram no navegador. No app de computador a conversão é
          bem mais rápida.
        </p>
      )}

      {jobs.length > 0 && (
        <>
          <div className="section-head">
            <h2>Envios</h2>
            {cleared && (
              <button className="link" onClick={clearFinished}>
                limpar concluídos
              </button>
            )}
          </div>
          <ul className="jobs">
            {jobs.map((j) => (
              <li
                key={j.id}
                className={`job ${j.status === "erro" ? "err" : ""}`}
              >
                <div className="job-text">
                  <span className="track-title">{j.name}</span>
                  <span className="track-sub">
                    {j.status}
                    {j.detail && ` · ${j.detail}`} · {formatBytes(j.size)}
                  </span>
                  {["convertendo", "enviando"].includes(j.status) && (
                    <div className="progress">
                      <div
                        style={{ width: `${Math.round(j.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                {j.result && (
                  <button
                    className="icon-btn"
                    title="Abrir"
                    onClick={() => openTrack(j.result!)}
                  >
                    <Icon name="more" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Quem baixa os links e por que precisa de Wi-Fi (sempre à vista na tela de
 * envio: quem pede pela primeira vez precisa saber).
 */
function WifiHint() {
  const { helpers, loaded } = useStore(importsStore);
  const spot = useStore(spotStore);
  return (
    <p className="muted small wifi-hint">
      Links são baixados por um celular Android com o app do yfitops aberto (ou tocando música) e{" "}
      <strong>conectado ao Wi-Fi</strong>, para ninguém gastar dados móveis baixando para os outros.{" "}
      {loaded && (helpers ? `${helpers} celular(es) ajudando agora.` : "Nenhum celular ajudando agora: o pedido espera na fila.")}
      {spot.capable && spot.reason === "só ajuda no Wi-Fi" && (
        <>
          {" "}
          <strong>Este celular está fora do Wi-Fi:</strong> conecte-se para ele baixar.
        </>
      )}
      {isAndroidBrowser() && (
        <>
          {" "}
          <a href="/yfitops.apk" download>
            Instale o app Android
          </a>{" "}
          para o seu celular ajudar.
        </>
      )}
    </p>
  );
}

const TRACK_STATUS: Record<ImportTrackStatus, string> = {
  queued: "na fila",
  working: "baixando em um celular…",
  done: "pronta",
  failed: "não deu",
  skipped: "ignorada",
};

/** Um link pedido: andamento, as músicas e o que dá para fazer com ele. */
function RequestCard({ r }: { r: ImportRequestInfo }) {
  const [open, setOpen] = useState(false);
  const done = finished(r);
  const failed = r.tracks.filter((t) => t.status === "failed");
  const queued = r.tracks.filter((t) => t.status === "queued");
  const ready = r.tracks.filter((t) => t.status === "done").length;
  const title = r.name || (r.tracks.length === 1 ? r.tracks[0].meta.title : "") || `Link do ${serviceName(r.url)}`;
  const cancel = async () => {
    const ok = await confirmDialog({
      title: "Cancelar o pedido?",
      message: "O que ainda não foi baixado não será. O que já chegou continua na sua biblioteca.",
      confirm: "cancelar pedido",
      danger: true,
    });
    if (ok) void dropRequest(r);
  };
  return (
    <li className={`request${r.status === "failed" || failed.length ? " has-err" : ""}`}>
      <div className="request-head">
        <span className="track-text">
          <span className="track-title">{title}</span>
          <span className={`track-sub${r.status === "failed" ? " err" : ""}`}>{requestProgress(r)}</span>
        </span>
        {r.tracks.length > 1 && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "esconder" : "ver músicas"}
          </button>
        )}
      </div>
      {!done && r.tracks.length > 0 && (
        <div className="progress">
          <div style={{ width: `${Math.round((ready / r.tracks.length) * 100)}%` }} />
        </div>
      )}
      {r.truncated && r.provider === "spotify" && <SpotifyLimit />}
      {open && (
        <ul className="request-tracks">
          {r.tracks.map((t) => (
            <li key={t.id} className={t.status}>
              <span className="track-text">
                <span className="track-title">{t.meta.title}</span>
                <span className={`track-sub${t.status === "failed" ? " err" : ""}`}>
                  {TRACK_STATUS[t.status]}
                  {t.error && t.status === "failed" && ` · ${t.error}`}
                </span>
              </span>
              {t.status === "queued" && (
                <button className="icon-btn" title="Não baixar esta" onClick={() => void skipTracks(r, [t.id])}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="import-result-actions">
        {done && (failed.length > 0 || r.status === "failed") && (
          <button className="primary" onClick={() => void retryRequest(r)}>
            tentar de novo{failed.length ? ` (${failed.length})` : ""}
          </button>
        )}
        {queued.length > 1 && (
          <button className="link" onClick={() => void skipTracks(r, queued.map((t) => t.id))}>
            ignorar as {queued.length} que faltam
          </button>
        )}
        {done ? (
          <button className="link" onClick={() => void dropRequest(r)}>
            dispensar
          </button>
        ) : (
          <button className="chip ghost" onClick={() => void cancel()}>
            cancelar
          </button>
        )}
      </div>
    </li>
  );
}
