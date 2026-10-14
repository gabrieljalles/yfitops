import { useEffect, useState } from "react";
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
import { confirmDialog } from "../lib/dialog";
import { libraryStore, sync, unshare } from "../lib/library";
import { useStore } from "../lib/observable";
import { askNotifyPermission, notifyPermission } from "../lib/notify";
import { canCrossfade, stop } from "../lib/player";
import { prefsStore, setPref } from "../lib/prefs";
import { checkResolver, DEFAULT_RESOLVER, type ResolverStatus } from "../lib/resolverConn";
import { StorageBar } from "../components/StorageBar";
import { logout, sessionStore } from "../lib/session";
import { formatBytes } from "../lib/tracks";
import { attempt } from "../lib/ui";

export function SettingsPage() {
  const session = useStore(sessionStore);
  const lib = useStore(libraryStore);
  const [quality, setQ] = useState<Quality>(getQuality());
  const [dlQuality, setDlQuality] = useState<DownloadQuality>(defaultDownloadQuality());
  const [local, setLocal] = useState(0);
  const prefs = useStore(prefsStore);
  const [permission, setPermission] = useState(notifyPermission());

  useEffect(() => {
    offlineUsage().then(setLocal);
  }, []);

  return (
    <div className="page settings">
      <section>
        <h2>Conta</h2>
        <p>{session?.email}</p>
        <StorageBar />
        <p className="muted small">
          {lib.syncing ? "sincronizando…" : lib.offline ? "Offline: as alterações ficam no aparelho até o servidor voltar" : lib.error ? `Erro no sync: ${lib.error}` : "Sincronizado"}{" "}
          <button className="link" onClick={() => void sync()}>
            sincronizar agora
          </button>
        </p>
      </section>

      <section>
        <h2>Aparência</h2>
        <div className="setting-row">
          <span>Tema</span>
          <Segmented
            value={prefs.theme}
            onChange={(v) => setPref("theme", v)}
            options={[
              ["system", "do aparelho"],
              ["dark", "escuro"],
              ["light", "claro"],
            ]}
          />
        </div>
        <div className="setting-row">
          <span>Tamanho do texto</span>
          <Segmented
            value={prefs.textSize}
            onChange={(v) => setPref("textSize", v)}
            options={[
              ["normal", "normal"],
              ["large", "grande"],
              ["larger", "maior"],
            ]}
          />
        </div>
      </section>

      <section>
        <h2>Reprodução</h2>
        {canCrossfade ? (
          <>
            <label className="setting-row">
              <span>
                Transição suave entre músicas
                <small className="muted">
                  {prefs.crossfade ? `A próxima entra nos últimos ${prefs.crossfade} s da atual` : "Desligada: uma música termina, a outra começa"}
                </small>
              </span>
              <span className="range-value">{prefs.crossfade ? `${prefs.crossfade} s` : "off"}</span>
            </label>
            {/* Mesmo visual da barra de posição do player. */}
            <div className="fp-seek setting-range">
              <input
                type="range"
                min={0}
                max={12}
                step={1}
                value={prefs.crossfade}
                onChange={(e) => setPref("crossfade", Number(e.target.value))}
                aria-label="Segundos de transição suave"
                style={{ "--pct": `${(prefs.crossfade / 12) * 100}%` } as React.CSSProperties}
              />
            </div>
          </>
        ) : (
          <p className="muted small">Transição suave entre músicas não funciona neste aparelho (o sistema não deixa o site mudar o volume).</p>
        )}
      </section>

      <section>
        <h2>Avisos</h2>
        <label className="setting-row">
          <span>
            Avisar quando uma importação ou envio terminar
            <small className="muted">
              {permission === "unsupported"
                ? "Este navegador não mostra avisos."
                : permission === "denied"
                  ? "Bloqueado no navegador: libere nas permissões do site."
                  : "Só aparece se o app estiver em segundo plano ou em outra tela."}
            </small>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={prefs.notify}
            disabled={permission === "unsupported"}
            onChange={async (e) => {
              setPref("notify", e.target.checked);
              if (e.target.checked) {
                await askNotifyPermission();
                setPermission(notifyPermission());
              }
            }}
          />
        </label>
      </section>

      <ResolverSettings />

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
        <p className="muted small">Qualidade sugerida ao baixar. Você também escolhe na hora, em cada música ou playlist.</p>
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
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Apagar downloads?",
              message: "As músicas baixadas saem deste aparelho, mas continuam na nuvem.",
              confirm: "apagar",
              danger: true,
            });
            if (ok) {
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
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Sair da conta?",
              message: "Você sai neste aparelho, e as músicas baixadas aqui são apagadas.",
              confirm: "sair",
              danger: true,
            });
            if (ok) {
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

/** Botões lado a lado para escolher uma opção (tema, tamanho do texto). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const RESOLVER_STATUS: Record<ResolverStatus, string> = {
  ok: "Conectado.",
  auth: "O servidor respondeu, mas a senha está errada ou faltando.",
  offline: "Não respondeu. Ele está ligado nesse endereço?",
};

/** Endereço e senha do servidor de importação (resolver), deste aparelho. */
function ResolverSettings() {
  const prefs = useStore(prefsStore);
  const [url, setUrl] = useState(prefs.resolverUrl);
  const [token, setToken] = useState(prefs.resolverToken);
  const [status, setStatus] = useState<ResolverStatus | "testing" | null>(null);

  async function save() {
    setPref("resolverUrl", url.trim());
    setPref("resolverToken", token.trim());
    setStatus("testing");
    setStatus(await checkResolver());
  }

  return (
    <section>
      <h2>Importar por link</h2>
      <p className="muted small">
        O servidor que lê links do YouTube, Spotify e Deezer roda no seu computador. Vale só neste aparelho.
      </p>
      <form
        className="form resolver-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span>Endereço</span>
          <input
            type="url"
            value={url}
            placeholder={DEFAULT_RESOLVER}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Senha (RESOLVER_TOKEN)</span>
          <input
            type="password"
            value={token}
            placeholder="sem senha"
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="submit" className="primary" disabled={status === "testing"}>
          {status === "testing" ? "testando…" : "salvar e testar"}
        </button>
      </form>
      {status && status !== "testing" && (
        <p className={`small ${status === "ok" ? "muted" : "error"}`} role="status">
          {RESOLVER_STATUS[status]}
        </p>
      )}
    </section>
  );
}
