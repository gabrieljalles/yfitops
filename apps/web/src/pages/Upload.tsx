import { useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { clearFinished, enqueue, jobsStore } from "../lib/importer";
import {
  importPlaylist,
  importTracks,
  isSpotifyLink,
  isYouTubeLink,
  isImportLink,
  type PlaylistResult,
} from "../lib/resolver";
import { useStore } from "../lib/observable";
import { formatBytes } from "../lib/tracks";
import { openTrack } from "../lib/ui";

export function UploadPage() {
  const jobs = useStore(jobsStore);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [linkError, setLinkError] = useState("");
  const [result, setResult] = useState<PlaylistResult | null>(null);
  const finished = jobs.some((j) =>
    ["pronto", "já existe", "erro"].includes(j.status),
  );

  async function run(work: () => Promise<PlaylistResult>) {
    if (busy) return;
    setBusy(true);
    setLinkError("");
    setResult(null);
    try {
      const r = await work();
      setResult(r);
      if (!r.failed.length) setLink("");
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setBusy(false);
      setNote("");
    }
  }
  const fetchPlaylist = () =>
    link.trim() && run(() => importPlaylist(link.trim(), setNote));
  const retryFailed = () =>
    result &&
    run(() =>
      importTracks(
        result.failed.map((f) => f.track),
        setNote,
      ),
    );
  const bigBatch = jobs.filter((j) => j.status === "na fila").length > 20;

  /** Serviço do link colado: muda a cor da borda, o ícone e a cor do botão. */
  const brand = isYouTubeLink(link)
    ? "youtube"
    : isSpotifyLink(link)
      ? "spotify"
      : null;

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

      <div className="link-import">
        <label className={`link-field${brand ? ` brand ${brand}` : ""}`}>
          <span className="link-brand" aria-hidden="true">
            <Icon
              name={brand === "spotify" ? "spotify" : "youtube"}
              size={20}
            />
          </span>
          <input
            type="url"
            value={link}
            placeholder="ou cole um link do YouTube ou do Spotify"
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchPlaylist()}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !isImportLink(link)}
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

      {result && !busy && (
        <div className="import-result">
          <p>
            <strong>{result.imported.length}</strong> importada(s)
            {result.existing.length > 0 && (
              <>
                {" · "}
                <strong>{result.existing.length}</strong> já estava(m) na
                biblioteca
              </>
            )}
            {result.failed.length > 0 && (
              <>
                {" · "}
                <strong className="err">{result.failed.length}</strong> não
                puderam ser baixada(s)
              </>
            )}
          </p>
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
                <span className="muted small">
                  Quer tentar baixar de novo as que faltaram?
                </span>
                <button className="primary" onClick={retryFailed}>
                  tentar de novo ({result.failed.length})
                </button>
                <button className="link" onClick={() => setResult(null)}>
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
