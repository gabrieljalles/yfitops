import { useEffect, useState } from "react";
import {
  cacheUsage,
  clearCache,
  freeSpace,
  trimCache,
  clearOffline,
  defaultDownloadQuality,
  getQuality,
  hasQualityChoice,
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
import { isAndroidBrowser } from "../lib/native";
import { spotStore } from "../lib/spot";
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
  const [cached, setCached] = useState(0);
  const [free, setFree] = useState<number | null>(null);
  const prefs = useStore(prefsStore);
  const [permission, setPermission] = useState(notifyPermission());
  // Escolha de qualidade só existe nas músicas de antes do catálogo (FLAC + versão leve).
  const qualityChoice = Object.values(lib.tracks).some(hasQualityChoice);

  useEffect(() => {
    offlineUsage().then(setLocal);
    cacheUsage().then(setCached);
    freeSpace().then(setFree);
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

      <HelpSettings />

      {qualityChoice && (
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
      )}

      <section>
        <h2>Downloads offline</h2>
        {qualityChoice && (
          <>
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
          </>
        )}
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

      <section>
        <h2>Músicas já ouvidas</h2>
        <p className="muted small">
          Cada música vem do servidor uma vez só: depois de ouvida, fica guardada aqui e tocar de novo não usa internet. Quando passa do limite,
          saem as ouvidas há mais tempo. Mais espaço = menos downloads repetidos (500 MB ≈ 85 músicas, 1 GB ≈ 170).
        </p>
        <div className="setting-row">
          <span>Guardar até</span>
          <Segmented
            value={String(prefs.cacheMB)}
            onChange={(v) => {
              setPref("cacheMB", Number(v));
              // Diminuiu: libera o excesso agora.
              void trimCache().then(() => cacheUsage().then(setCached));
            }}
            options={[
              ["512", "500 MB"],
              ["1024", "1 GB"],
              ["2048", "2 GB"],
              ["4096", "4 GB"],
              ["8192", "8 GB"],
            ]}
          />
        </div>
        <p className="muted small">
          {formatBytes(cached)} guardados agora
          {free !== null && ` · ${formatBytes(free)} livres para o app neste aparelho`}
        </p>
        {free !== null && prefs.cacheMB * 1024 * 1024 > free + cached && (
          <p className="small error">
            Este aparelho não tem espaço para {formatBytes(prefs.cacheMB * 1024 * 1024)}. O app guarda o que couber e as músicas continuam tocando
            normalmente; só as que não couberem serão baixadas de novo.
          </p>
        )}
        <button
          className="link danger"
          onClick={() =>
            void attempt(async () => {
              await clearCache();
              setCached(0);
            }, "Músicas ouvidas apagadas do aparelho")
          }
        >
          Limpar
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

/**
 * Ajudar a baixar as músicas pedidas por link. Só o app Android consegue (o
 * navegador não deixa um site baixar do YouTube), e só no Wi-Fi. Todo app
 * Android ajuda: não há como desligar.
 */
function HelpSettings() {
  const spot = useStore(spotStore);
  return (
    <section>
      <h2>Baixar músicas pedidas por link</h2>
      {spot.capable ? (
        <>
          <div className="setting-row">
            <span>
              Este celular ajuda a baixar
              <small className="muted">
                Todo app Android ajuda, só no Wi-Fi e com o app aberto ou tocando música. Baixa para quem pediu (pode ser outra pessoa): a música vai
                só para o servidor e não fica neste celular nem entra na sua biblioteca.
              </small>
            </span>
          </div>
          <p className="muted small" role="status">
            {spot.resting
              ? "O YouTube pediu uma pausa a este celular. Ele volta a ajudar sozinho em até 30 minutos; enquanto isso, outros celulares seguem."
              : spot.active
                ? `${spot.doing ? `Agora: ${spot.doing}.` : "Pronto para ajudar: esperando pedidos."}${spot.done ? ` Já baixou ${spot.done} música(s) desde que o app abriu.` : ""}`
                : `Parado: ${spot.reason}.`}
          </p>
        </>
      ) : isAndroidBrowser() ? (
        <p className="muted small">
          Quem baixa as músicas pedidas por link são celulares Android com o app do yfitops. Instale o app para o seu celular ajudar
          (só no Wi-Fi): <a href="/yfitops.apk" download>baixar o app Android</a>. Depois de instalar, abra pelo ícone novo.
        </p>
      ) : (
        <p className="muted small">
          Quem baixa as músicas pedidas por link são celulares Android com o app do yfitops, abertos e no Wi-Fi. Este aparelho só pede:
          os pedidos ficam na fila até um desses celulares pegar.
        </p>
      )}
    </section>
  );
}
