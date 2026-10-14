import { useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { clearFinished, enqueue, jobsStore } from "../lib/importer";
import { isSpotifyLink, isYouTubeLink } from "../lib/resolver";
import { dismissImportResult, linkImportStore, retryLinkImport, setImportLink, skipAllPending, startLinkImport, toggleSkip } from "../lib/linkImport";
import { useStore } from "../lib/observable";
import { formatBytes } from "../lib/tracks";
import { openTrack } from "../lib/ui";
import { navigate } from "../router";

export function UploadPage() {
  const jobs = useStore(jobsStore);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Vem de um store (e não de useState) para sobreviver à troca de tela.
  const { link, busy, note, error: linkError, result, tracks, current, skipped } = useStore(linkImportStore);
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
  const brand = isYouTubeLink(link) ? "youtube" : isSpotifyLink(link) ? "spotify" : null;

  return (
    <div className="page">
      <div
        className={`dropzone${over ? " over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
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
            enqueue([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      <div className={`link-import${brand ? ` linked ${brand}` : ""}`}>
        <label className="link-field">
          <span className="link-brand" aria-hidden="true">
            <Icon name={brand === "spotify" ? "spotify" : "youtube"} size={20} />
          </span>
          <input
            type="url"
            value={link}
            placeholder="ou cole um link do YouTube ou do Spotify"
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
        {(note || linkError) && (
          <span className={`muted small${linkError ? " err" : ""}`}>
            {linkError || note}
          </span>
        )}
      </div>

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
                <li key={`${t.videoId || t.spotifyId || t.title}-${i}`}>
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
            <strong>Formatos comuns e leves</strong> (MP3, AAC/M4A, OGG, Opus)
            ficam <strong>exatamente como estão</strong>. Já são pequenos, e
            reconverter só pioraria.
          </li>
          <li>
            <strong>Formatos sem perda e pesados</strong> (WAV, AIFF, ALAC, APE,
            WavPack, TTA, FLAC) viram <strong>FLAC</strong>, cerca de 40–60% do
            tamanho de um WAV, com as mesmas amostras. Antes de enviar, o app
            confere bit a bit com o original. Se algo não bater, guarda o
            original.
          </li>
          <li>
            <strong>DSD</strong> (DSF/DFF) vira FLAC 24-bit/176,4 kHz: a
            conversão padrão de estúdio, inaudível e muito menor. Por natureza
            do DSD, essa não é uma cópia bit a bit.
          </li>
          <li>
            <strong>Formatos com perda menos comuns</strong> (WMA, AC3, DTS,
            MP2, AMR…): o original é guardado intacto, mais uma versão para
            tocar em qualquer aparelho.
          </li>
          <li>
            <strong>Vídeos</strong> (MP4, MKV, WEBM, MOV…): o app separa só o
            áudio, sem reconverter, e descarta o vídeo.
          </li>
          <li>
            Arquivos grandes também ganham uma versão{" "}
            <strong>Opus 160 kbps</strong>, leve, para o 4G. Tudo é
            criptografado neste aparelho antes de subir.
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
