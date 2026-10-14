import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  clearOffline,
  defaultDownloadQuality,
  getQuality,
  offlineUsage,
  setDefaultDownloadQuality,
  setQuality,
  type DownloadQuality,
  type Quality,
} from "../lib/blobs";
import { libraryStore, sync, unshare } from "../lib/library";
import { useStore } from "../lib/observable";
import { stop } from "../lib/player";
import { logout, sessionStore } from "../lib/session";
import { formatBytes } from "../lib/tracks";
import { attempt } from "../lib/ui";

export function SettingsPage() {
  const session = useStore(sessionStore);
  const lib = useStore(libraryStore);
  const [quality, setQ] = useState<Quality>(getQuality());
  const [dlQuality, setDlQuality] = useState<DownloadQuality>(defaultDownloadQuality());
  const [usage, setUsage] = useState<{ bytes: number; quota: number; count: number } | null>(null);
  const [local, setLocal] = useState(0);

  useEffect(() => {
    api.json<{ bytes: number; quota: number; count: number }>("/blobs").then(setUsage, () => {});
    offlineUsage().then(setLocal);
  }, []);

  return (
    <div className="page settings">
      <section>
        <h2>Conta</h2>
        <p>{session?.email}</p>
        {usage && (
          <>
            <div className="progress">
              <div style={{ width: `${Math.min(100, (usage.bytes / usage.quota) * 100)}%` }} />
            </div>
            <p className="muted small">
              {formatBytes(usage.bytes)} de {formatBytes(usage.quota)} na nuvem · {usage.count} arquivos
            </p>
          </>
        )}
        <p className="muted small">
          {lib.syncing ? "sincronizando…" : lib.error ? `Erro no sync: ${lib.error}` : "Sincronizado"}{" "}
          <button className="link" onClick={() => void sync()}>
            sincronizar agora
          </button>
        </p>
      </section>

      <section>
        <h2>Qualidade ao tocar</h2>
        {(
          [
            ["auto", "Automática", "Original no Wi-Fi, versão leve (Opus) nos dados móveis"],
            ["high", "Máxima", "Sempre FLAC/original"],
            ["light", "Leve", "Sempre Opus 160 kbps (transparente ao ouvido)"],
          ] as const
        ).map(([v, label, hint]) => (
          <label key={v} className="radio">
            <input
              type="radio"
              name="q"
              checked={quality === v}
              onChange={() => {
                setQuality(v);
                setQ(v);
              }}
            />
            <span>
              {label}
              <small className="muted">{hint}</small>
            </span>
          </label>
        ))}
      </section>

      <section>
        <h2>Downloads offline</h2>
        <p className="muted small">Qualidade sugerida ao baixar. Você também escolhe na hora, em cada música ou grupo.</p>
        {(
          [
            ["normal", "Normal", "Opus 160 kbps: transparente ao ouvido, ~6× menor"],
            ["max", "Máxima", "FLAC sem perda: idêntico ao original"],
          ] as const
        ).map(([v, label, hint]) => (
          <label key={v} className="radio">
            <input
              type="radio"
              name="dl"
              checked={dlQuality === v}
              onChange={() => {
                setDefaultDownloadQuality(v);
                setDlQuality(v);
              }}
            />
            <span>
              {label}
              <small className="muted">{hint}</small>
            </span>
          </label>
        ))}
        <p className="muted small">{formatBytes(local)} guardados neste aparelho</p>
        <button
          className="link danger"
          onClick={() => {
            if (confirm("Apagar todas as músicas baixadas deste aparelho? Elas continuam na nuvem.")) {
              void attempt(async () => {
                await clearOffline();
                setLocal(0);
              }, "Downloads apagados");
            }
          }}
        >
          Apagar downloads
        </button>
      </section>

      {lib.sent.length > 0 && (
        <section>
          <h2>Você compartilhou</h2>
          <ul className="plain">
            {lib.sent.map((s) => (
              <li key={s.shareId} className="row between">
                <span>
                  {s.playlistName} <span className="muted">→ {s.toEmail}</span>
                </span>
                <button className="link danger" onClick={() => attempt(() => unshare(s.shareId), "Compartilhamento removido")}>
                  parar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <button
          className="link danger"
          onClick={() => {
            if (confirm("Sair desta conta neste aparelho? Os downloads daqui serão apagados.")) {
              stop();
              void logout();
            }
          }}
        >
          Sair da conta
        </button>
      </section>
    </div>
  );
}
