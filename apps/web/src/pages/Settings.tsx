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
import { api } from "../lib/api";
import type { ReferralInfo, ReferralStage } from "@yfitops/core";
import { brl, formatDate, formatPhone, inviteLink } from "../lib/billing";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { libraryStore, sync } from "../lib/library";
import { useStore } from "../lib/observable";
import { askNotifyPermission, notifyPermission } from "../lib/notify";
import { canCrossfade, stop } from "../lib/player";
import { prefsStore, setPref } from "../lib/prefs";
import { HELPER_REOPENS_BUILD, nativeBuild } from "../lib/native";
import { setHelper, spotStore } from "../lib/spot";
import { StorageBar } from "../components/StorageBar";
import { logout, refreshAccount, sessionStore } from "../lib/session";
import { formatBytes } from "../lib/tracks";
import { attempt, toast } from "../lib/ui";

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
        <p className="muted small">
          {session?.phone ? formatPhone(session.phone) : "Sem celular cadastrado"}{" "}
          <button
            className="link"
            onClick={async () => {
              const phone = await promptDialog({
                title: "Seu celular",
                message: "Com DDD. É por ele que avisamos sobre o pagamento.",
                input: { type: "tel", value: formatPhone(session?.phone), placeholder: "(11) 98765-4321" },
                confirm: "salvar",
              });
              if (phone) {
                void attempt(async () => {
                  await api.json("/auth/phone", { method: "PUT", json: { phone } });
                  await refreshAccount();
                }, "Celular salvo");
              }
            }}
          >
            {session?.phone ? "trocar" : "adicionar"}
          </button>
        </p>
        {session?.paidUntil !== undefined && <p className="muted small">Acesso liberado até {formatDate(session.paidUntil)}</p>}
        <StorageBar />
        <p className="muted small">
          {lib.syncing ? "sincronizando…" : lib.offline ? "Offline: as alterações ficam no aparelho até o servidor voltar" : lib.error ? `Erro no sync: ${lib.error}` : "Sincronizado"}{" "}
          <button className="link" onClick={() => void sync()}>
            sincronizar agora
          </button>
        </p>
      </section>

      {session?.referral && <ReferralSettings />}

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
 * Android ajuda: não há como desligar. Nos outros aparelhos a seção não aparece
 * (quem só pede não precisa saber como a música é baixada).
 */
/** Em que pé está cada pessoa indicada. */
function stageText(p: ReferralInfo["people"][number]): string {
  const value = p.amountCents ? brl(p.amountCents) : "";
  const text: Record<ReferralStage, string> = {
    pending: "esperando aprovação",
    unpaid: "entrou, ainda não pagou",
    waiting: `pagou · ${value} liberado em ${formatDate(p.availableAt ?? 0)}`,
    available: `${value} a receber`,
    paid: `${value} recebido`,
    canceled: "não contou (pagamento cancelado)",
  };
  return text[p.stage];
}

/**
 * Programa de indicação (só para quem foi liberado): o link pessoal, quem chegou por
 * ele e quanto tem a receber. A divulgação é de pessoa para pessoa.
 */
function ReferralSettings() {
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  useEffect(() => {
    void attempt(async () => setInfo(await api.json<ReferralInfo>("/referral")));
  }, []);
  if (!info) return null;
  const link = inviteLink(info.code);
  const message = `Te convidei para o Yfitops, o app de música que eu uso: ${link}`;
  const { waitingCents, availableCents, paidCents } = info.totals;
  return (
    <section className="referral">
      <h2>Indicações</h2>
      <p className="muted small">
        Mande o seu link só para quem você conhece, numa conversa. Quem entrar por ele espera a aprovação, e você ganha{" "}
        {info.rewardCents ? <strong>{brl(info.rewardCents)}</strong> : "um valor"} por pessoa que pagar a primeira mensalidade. O valor fica
        guardado por 30 dias e depois é pago a você.
      </p>
      <div className="invite-link">
        <code>{link}</code>
        <span className="row wrap">
          <button
            className="chip"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast("Link copiado");
              } catch {
                await promptDialog({ title: "Seu link de convite", input: { value: link }, confirm: "ok" });
              }
            }}
          >
            copiar link
          </button>
          <a className="chip ghost" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
            mandar no WhatsApp
          </a>
        </span>
      </div>
      <p className="small">
        A receber: <strong>{brl(availableCents)}</strong> · guardado: {brl(waitingCents)} · já recebido: {brl(paidCents)}
      </p>
      {info.people.length ? (
        <ul className="plain referral-people">
          {info.people.map((p, i) => (
            <li key={i} className="small">
              <span>{p.email}</span>
              <span className={`muted${p.stage === "available" ? " tone-text-ok" : ""}`}>{stageText(p)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Ninguém entrou pelo seu link ainda.</p>
      )}
    </section>
  );
}

function HelpSettings() {
  const spot = useStore(spotStore);
  const admin = !!useStore(sessionStore)?.admin;
  const [build, setBuild] = useState(0);
  useEffect(() => void nativeBuild().then(setBuild), []);
  if (!spot.capable) return null;
  return (
    <section>
      <h2>Baixar músicas pedidas por link</h2>
      <div className="setting-row">
        <span>
          Este celular ajuda a baixar
          <small className="muted">
            No Wi-Fi, com o app aberto ou tocando música. Nos dados móveis, só os seus pedidos.
          </small>
        </span>
      </div>
      {(admin || spot.helper) && (
        <label className="setting-row">
          <span>
            Celular ajudante (24 horas)
            <small className="muted">
              Para um celular que fica só para isso, ligado no carregador e no Wi-Fi: baixa os pedidos de todo mundo o tempo todo,
              com a tela desligada e sem música. Ao ligar, aceite as duas permissões que o Android pedir (bateria e "aparecer sobre
              outros apps"): com elas o app abre sozinho quando o celular liga ou quando é fechado.
            </small>
          </span>
          <input type="checkbox" className="switch" checked={spot.helper} onChange={(e) => setHelper(e.target.checked)} />
        </label>
      )}
      {spot.helper && build > 0 && build < HELPER_REOPENS_BUILD && (
        <p className="muted small">
          Para o app abrir sozinho quando o celular ligar, <a href={`http://${location.host}/api/app/apk`}>instale o app novo</a> por cima.
        </p>
      )}
      <p className="muted small" role="status">
        {spot.resting
          ? "O YouTube pediu uma pausa a este celular. Ele volta a ajudar sozinho em até 30 minutos; enquanto isso, outros celulares seguem."
          : spot.active
            ? `${spot.doing ? `Agora: ${spot.doing}.` : "Pronto para ajudar: esperando pedidos."}${spot.done ? ` Já baixou ${spot.done} música(s) desde que o app abriu.` : ""}`
            : `Parado: ${spot.reason}.`}
      </p>
    </section>
  );
}
