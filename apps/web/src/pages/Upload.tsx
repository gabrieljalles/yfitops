import { useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { clearFinished, enqueue, jobsStore } from "../lib/importer";
import { isDeezerLink, isSpotifyLink, isYouTubeLink } from "../lib/resolver";
import { StorageBar } from "../components/StorageBar";
import { TagInput } from "../components/TagInput";
import { answerLinkAsk, answerLinkPick, cancelLinkImport, setImportTags, dismissImportResult, linkImportStore, retryLinkImport, setImportLink, skipAllPending, startLinkImport, toggleSkip } from "../lib/linkImport";
import { askNotifyPermission } from "../lib/notify";
import { useStore } from "../lib/observable";
import { formatBytes } from "../lib/tracks";
import { openTrack } from "../lib/ui";
import { navigate } from "../router";

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
  const { link, busy, note, error: linkError, result, tracks, current, skipped, ask, pick, tags } = useStore(linkImportStore);
  /** Ainda não começaram: dá para ignorar (ou desfazer) clicando. */
  const upcoming = busy ? tracks.slice(current + 1) : [];
  const toSkip = upcoming.filter((t) => !skipped.has(t)).length;
  const finished = jobs.some((j) =>
    ["pronto", "já existe", "erro"].includes(j.status),
  );

  const fetchPlaylist = startLinkImport;
  const retryFailed = retryLinkImport;
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
            disabled={busy}
            onChange={(e) => setImportLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchPlaylist()}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !link.trim()}
          onClick={fetchPlaylist}
        >
          {busy ? "importando..." : "importar"}
        </button>
        {/* Antes do 1º download (lendo o link): dá para desistir sem baixar nada. */}
        {busy && !tracks.length && !ask && !pick && (
          <button className="chip ghost" onClick={cancelLinkImport}>
            cancelar
          </button>
        )}
        {(note || linkError) && (
          <span className={`muted small${linkError ? " err" : ""}`}>
            {linkError || note}
          </span>
        )}
      </div>

      {/* Opcional: só aparece com um link válido (ou se já houver tags escolhidas). */}
      {(brand || tags.length > 0) && (
        <div className="import-tags">
          <span className="muted small">
            Tags para todas as músicas <span className="muted">(opcional)</span>
          </span>
          <TagInput tags={tags} onChange={setImportTags} placeholder="ex.: academia, anos-80…" disabled={busy} />
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
            <button className="chip ghost" onClick={cancelLinkImport}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {ask && (
        <div className="import-result">
          <p>
            A playlist <strong>{ask.name}</strong> tem <strong>{ask.count}</strong> músicas.
            Quer que elas fiquem ligadas a uma playlist no app?
          </p>
          {ask.truncated && <SpotifyLimit />}
          <div className="import-result-actions">
            <button className="primary" onClick={() => answerLinkAsk(true)}>
              baixar e criar a playlist
            </button>
            <button className="link" onClick={() => answerLinkAsk(false)}>
              só baixar as músicas
            </button>
            <button className="chip ghost" onClick={cancelLinkImport}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="import-queue">
          <div className="section-head">
            <span className="small">
              <strong>Ainda vão ser baixadas</strong> · {toSkip} de {upcoming.length}
              <span className="muted"> · clique para ignorar</span>
            </span>
            {toSkip > 0 && (
              <button className="chip danger" onClick={skipAllPending}>
                <Icon name="close" size={14} /> ignorar todas
              </button>
            )}
          </div>
          <ul>
            {upcoming.map((t, i) => {
              const off = skipped.has(t);
              return (
                <li key={`${t.videoId || t.spotifyId || t.deezerId || t.title}-${i}`}>
                  <button
                    className={off ? "skipped" : ""}
                    onClick={() => toggleSkip(t)}
                    title={off ? "Vai ser ignorada · clique para baixar de novo" : "Clique para não baixar esta"}
                  >
                    <span className="track-text">
                      <span className="track-title">{t.title}</span>
                      <span className="track-sub">{off ? "ignorada · clique para desfazer" : t.artist}</span>
                    </span>
                    <Icon name={off ? "plus" : "close"} size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {result && !busy && (
        <div className="import-result">
          <p>
            <strong>{result.imported.length}</strong> importada(s)
            {result.existing.length > 0 && (
              <>
                {" · "}
                <strong>{result.existing.length}</strong> já estava(m) na biblioteca
              </>
            )}
            {result.skipped.length > 0 && (
              <>
                {" · "}
                <strong>{result.skipped.length}</strong> ignorada(s)
              </>
            )}
            {result.failed.length > 0 && (
              <>
                {" · "}
                <strong className="err">{result.failed.length}</strong> não puderam ser baixada(s)
              </>
            )}
          </p>
          {result.truncated && <SpotifyLimit />}
          {result.tags && (
            <p className="small muted">
              Com as tags {result.tags.map((t) => `#${t}`).join(" ")}
            </p>
          )}
          {result.playlist && (
            <p className="small">
              Tudo ligado à playlist{" "}
              <button className="link" onClick={() => navigate(`/playlist/${result.playlist!.id}`)}>
                {result.playlist.name}
              </button>
              {result.failed.length > 0 && " (as que faltam entram nela ao tentar de novo)"}
            </p>
          )}
          {result.failed.length > 0 && (
            <>
              <ul>
                {result.failed.map(({ track, reason }) => (
                  <li key={track.videoId}>
                    <span className="track-title">{track.title}</span>
                    <span className="track-sub err">{reason}</span>
                  </li>
                ))}
              </ul>
              <div className="import-result-actions">
                <span className="muted small">Quer tentar baixar de novo as que faltaram?</span>
                <button className="primary" onClick={retryFailed}>
                  tentar de novo ({result.failed.length})
                </button>
                <button className="link" onClick={dismissImportResult}>
                  agora não
                </button>
              </div>
            </>
          )}
        </div>
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
            {finished && (
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
