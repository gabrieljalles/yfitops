import { useCallback, useEffect, useState } from "react";
import type { SongInfo } from "@yfitops/core";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { coverRef } from "../lib/catalog";
import { confirmDialog } from "../lib/dialog";
import { refreshAccount } from "../lib/session";
import { formatBytes, formatTime, musicas } from "../lib/tracks";
import { attempt } from "../lib/ui";
import { refreshUsage } from "../lib/usage";

// Painel administrativo. Só é carregado para quem é administrador (o servidor
// diz quem é); para os outros, esta tela nem é baixada.

interface AdminUser {
  id: string;
  email: string;
  status: "approved" | "pending";
  createdAt: number;
  songs: number;
  bytes: number;
  lastLogin: number | null;
  admin: boolean;
  me: boolean;
}

interface Overview {
  usage: { bytes: number; quota: number; count: number };
  users: AdminUser[];
}

type AdminSong = SongInfo & { createdAt: number; uploadedBy: string | null };

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "nunca");

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);

  const load = useCallback(async () => {
    setData(await api.json<Overview>("/admin/overview"));
    void refreshAccount(); // atualiza o número de pedidos no menu
  }, []);

  useEffect(() => {
    void attempt(load);
  }, [load]);

  if (!data) return <div className="page muted">Carregando…</div>;
  const pending = data.users.filter((u) => u.status === "pending");
  const people = data.users.filter((u) => u.status !== "pending");
  const pct = Math.min(100, (data.usage.bytes / data.usage.quota) * 100);

  const approve = (u: AdminUser) => attempt(async () => (await api.json(`/admin/users/${u.id}/approve`, { method: "POST" }), load()), `${u.email} pode entrar`);

  /** Para quem esqueceu a senha: o link vai por mensagem (o app não manda e-mail para todos). */
  const resetLink = (u: AdminUser) =>
    attempt(async () => {
      const { link } = await api.json<{ link: string }>(`/admin/users/${u.id}/reset-link`, { method: "POST" });
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch {
        /* sem permissão para copiar: mostra o link para copiar à mão */
      }
      await confirmDialog({
        title: copied ? "Link copiado" : "Link de senha nova",
        message: `${copied ? "Mande para" : "Copie e mande para"} ${u.email} (WhatsApp, por exemplo). Vale por 1 hora, e a pessoa não perde nada da biblioteca.\n\n${link}`,
        confirm: "ok",
      });
    });

  const remove = async (u: AdminUser, pendingRequest: boolean) => {
    const ok = await confirmDialog(
      pendingRequest
        ? { title: "Recusar o pedido?", message: `${u.email} não vai conseguir entrar. Se pedir de novo, aparece aqui outra vez.`, confirm: "recusar", danger: true }
        : {
            title: "Tirar o acesso?",
            message: `A conta de ${u.email} é apagada, com biblioteca e playlists. As músicas que essa pessoa trouxe continuam no catálogo.`,
            confirm: "apagar conta",
            danger: true,
          },
    );
    if (ok) await attempt(async () => (await api.json(`/admin/users/${u.id}`, { method: "DELETE" }), load()), pendingRequest ? "Pedido recusado" : "Conta apagada");
  };

  return (
    <div className="page settings admin">
      <section>
        <h2>Pedidos de acesso</h2>
        {pending.length ? (
          <ul className="plain admin-list">
            {pending.map((u) => (
              <li key={u.id}>
                <span className="admin-who">
                  <strong>{u.email}</strong>
                  <small className="muted">pediu em {date(u.createdAt)}</small>
                </span>
                <span className="row">
                  <button className="primary" onClick={() => void approve(u)}>
                    <Icon name="check" size={16} /> aceitar
                  </button>
                  <button className="link danger" onClick={() => void remove(u, true)}>
                    recusar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Ninguém esperando.</p>
        )}
      </section>

      <section>
        <h2>Nuvem</h2>
        <div className="progress" role="meter" aria-label="Espaço usado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <p className="small">
          {formatBytes(data.usage.bytes)} de {formatBytes(data.usage.quota)} ({Math.round(pct)}%) · {musicas(data.usage.count)} no catálogo
        </p>
        <button
          className="link"
          onClick={() =>
            void attempt(async () => {
              const r = await api.json<{ abandoned: number; merged: number }>("/admin/tidy", { method: "POST" });
              await load();
              void refreshUsage();
              return r;
            }, "Faxina feita")
          }
        >
          juntar duplicadas agora
        </button>
        <p className="muted small">A faxina também roda sozinha todo dia de madrugada.</p>
      </section>

      <Consumption />

      <section>
        <h2>Pessoas</h2>
        <ul className="plain admin-list">
          {people.map((u) => (
            <li key={u.id}>
              <span className="admin-who">
                <strong>
                  {u.email}
                  {u.me && <span className="muted"> (você)</span>}
                </strong>
                <small className="muted">
                  desde {date(u.createdAt)} · último acesso {date(u.lastLogin)} · trouxe {musicas(u.songs)} ({formatBytes(u.bytes)})
                </small>
              </span>
              <span className="row">
                <button className="link" onClick={() => void resetLink(u)}>
                  link de senha nova
                </button>
                {!u.admin && (
                  <button className="link danger" onClick={() => void remove(u, false)}>
                    tirar acesso
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <CatalogAdmin onChange={load} />
    </div>
  );
}

/** Músicas do catálogo: apagar aqui tira do sistema (da nuvem e da biblioteca de todos). */
function CatalogAdmin({ onChange }: { onChange: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "size" | "title">("recent");
  const [songs, setSongs] = useState<AdminSong[]>([]);
  const [more, setMore] = useState(false);
  /** Escolhendo várias para apagar de uma vez (null = fora do modo de seleção). */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchPage = useCallback(
    async (offset: number) => {
      const r = await api.json<{ songs: AdminSong[]; more: boolean }>(
        `/admin/songs?q=${encodeURIComponent(q)}&sort=${sort}&offset=${offset}`,
      );
      setSongs((cur) => (offset ? [...cur, ...r.songs] : r.songs));
      setMore(r.more);
    },
    [q, sort],
  );

  useEffect(() => {
    const t = setTimeout(() => void attempt(() => fetchPage(0)), 300);
    return () => clearTimeout(t);
  }, [fetchPage]);

  /** Apaga do sistema (uma ou várias): pede confirmação uma vez só. */
  const remove = async (list: AdminSong[]) => {
    if (!list.length) return;
    const ok = await confirmDialog({
      title: "Apagar do sistema?",
      message: `${list.length === 1 ? `"${list[0].title}" sai` : `${list.length} músicas saem`} da nuvem e da biblioteca de todo mundo. Não dá para desfazer.`,
      confirm: list.length === 1 ? "apagar" : `apagar ${list.length}`,
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    await attempt(async () => {
      const ids = list.map((x) => x.id);
      for (let i = 0; i < ids.length; i += 100) {
        await api.json("/admin/songs/delete", { method: "POST", json: { ids: ids.slice(i, i + 100) } });
      }
      const gone = new Set(ids);
      setSongs((cur) => cur.filter((x) => !gone.has(x.id)));
      setSelected(null);
      await onChange();
      void refreshUsage();
    }, list.length === 1 ? "Música apagada do sistema" : `${list.length} músicas apagadas do sistema`);
    setDeleting(false);
  };
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = !!selected && songs.length > 0 && songs.every((x) => selected.has(x.id));

  return (
    <section>
      <h2>Músicas do catálogo</h2>
      <div className="admin-filters">
        <input className="search-input" type="search" placeholder="Música, artista ou álbum" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segmented" role="radiogroup" aria-label="Ordem">
          {(
            [
              ["recent", "recentes"],
              ["size", "maiores"],
              ["title", "A–Z"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={sort === v} className={sort === v ? "on" : ""} onClick={() => setSort(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {songs.length > 0 &&
        (selected ? (
          <div className="section-head select-bar">
            <span className="small">
              <strong>{selected.size}</strong> {selected.size === 1 ? "selecionada" : "selecionadas"}
            </span>
            <div className="row wrap">
              <button className="chip ghost" disabled={deleting} onClick={() => setSelected(allSelected ? new Set() : new Set(songs.map((x) => x.id)))}>
                {allSelected ? "desmarcar todas" : `selecionar todas (${songs.length})`}
              </button>
              <button className="chip danger" disabled={!selected.size || deleting} onClick={() => void remove(songs.filter((x) => selected.has(x.id)))}>
                <Icon name="trash" size={14} /> {deleting ? "apagando…" : `apagar${selected.size ? ` (${selected.size})` : ""}`}
              </button>
              <button className="chip ghost" disabled={deleting} onClick={() => setSelected(null)}>
                cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="section-head">
            <span className="muted small">{musicas(songs.length)}{more ? " (mostrando as primeiras)" : ""}</span>
            <button className="chip ghost" onClick={() => setSelected(new Set())}>
              <Icon name="check" size={14} /> selecionar
            </button>
          </div>
        ))}
      {songs.length ? (
        <ul className="tracks admin-songs">
          {songs.map((s) => (
            <li key={s.id} className={selected?.has(s.id) ? "selected" : ""}>
              <div
                className="track-main"
                role={selected ? "button" : undefined}
                aria-pressed={selected ? selected.has(s.id) : undefined}
                onClick={selected ? () => toggle(s.id) : undefined}
              >
                {selected && (
                  <span className={`check-box${selected.has(s.id) ? " on" : ""}`} aria-hidden="true">
                    {selected.has(s.id) && <Icon name="check" size={14} />}
                  </span>
                )}
                <Cover cover={coverRef(s)} seed={s.title + s.artist} size={44} />
                <span className="track-text">
                  <span className="track-title">{s.title}</span>
                  <span className="track-sub">
                    {s.artist} · {formatTime(s.duration)} · {formatBytes(s.size + s.coverSize)} · {s.uploadedBy ?? "conta apagada"} · {date(s.createdAt)}
                  </span>
                </span>
              </div>
              {!selected && (
                <button className="icon-btn danger" title="Apagar do sistema" onClick={() => void remove([s])}>
                  <Icon name="trash" size={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nenhuma música.</p>
      )}
      {more && (
        <button className="link" onClick={() => void attempt(() => fetchPage(songs.length))}>
          mostrar mais
        </button>
      )}
    </section>
  );
}

// ---------------- Consumo da Cloudflare ----------------

interface PerDay {
  month: number;
  today: number;
  maxDay: number;
}

interface ConsumptionData {
  configured: boolean;
  updatedAt?: number;
  month?: { start: number; daysInMonth: number; elapsedDays: number };
  r2?: { classA: number; classB: number; storedBytes: number | null; objects: number | null };
  workers?: PerDay;
  d1Read?: PerDay;
  d1Written?: PerDay;
  app?: { bytes: number; quota: number; count: number };
  errors?: string[];
}

const GB = 1024 ** 3;
const num = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`
    : n >= 1000
      ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`
      : n.toLocaleString("pt-BR");
const gb = (bytes: number) => `${(bytes / GB).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} GB`;
const usd = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "USD" });

/**
 * Consumo do mês, com os números da própria Cloudflare. Só busca quando o
 * administrador clica em "atualizar dados" (abrir o painel não gasta nada).
 */
function Consumption() {
  const [data, setData] = useState<ConsumptionData | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    attempt(async () => {
      setBusy(true);
      try {
        setData(await api.json<ConsumptionData>("/admin/consumption", { method: "POST" }));
      } finally {
        setBusy(false);
      }
    });

  const m = data?.month;
  // Ritmo do mês até agora, esticado até o fim do mês.
  const project = (v: number) => (m ? (v / m.elapsedDays) * m.daysInMonth : v);

  return (
    <section className="consumption">
      <div className="row between consumption-head">
        <h2>Consumo da Cloudflare</h2>
        <button className="primary" onClick={() => void refresh()} disabled={busy}>
          <Icon name="sync" size={16} /> {busy ? "buscando…" : "atualizar dados"}
        </button>
      </div>
      {!data ? (
        <p className="muted small">
          Os números vêm da própria Cloudflare (os mesmos da cobrança) e só são buscados quando você clica em atualizar. A linha vermelha marca
          onde a Cloudflare começaria a cobrar.
        </p>
      ) : !data.configured ? (
        <div className="small">
          <p>Falta a chave de leitura da Cloudflare. Para ligar:</p>
          <ol className="steps">
            <li>
              No painel da Cloudflare: <strong>Meu perfil → Tokens de API → Criar token → Personalizado</strong>.
            </li>
            <li>
              Permissão: <strong>Conta → Account Analytics → Ler</strong>. Nada mais.
            </li>
            <li>
              No PC, na pasta <code>server</code>: <code>npx wrangler secret put CF_API_TOKEN</code> e cole o token.
            </li>
          </ol>
        </div>
      ) : (
        <>
          <p className="muted small">
            Mês até agora ({Math.floor(m!.elapsedDays)} de {m!.daysInMonth} dias) · atualizado às{" "}
            {new Date(data.updatedAt!).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. A barra clara é a previsão para o mês
            inteiro, no ritmo atual.
          </p>

          <h3 className="consumption-group">Armazenamento de músicas (R2) · o único que cobra</h3>
          <Meter
            label="Espaço guardado"
            value={data.r2!.storedBytes ?? data.app!.bytes}
            limit={10 * GB}
            format={gb}
            note={`${num(data.r2!.objects ?? data.app!.count)} arquivos. O app trava novos envios em ${gb(data.app!.quota)}.`}
            price={(over) => usd((over / GB) * 0.015) + " por mês"}
          />
          <Meter
            label="Gravações no mês (Classe A)"
            value={data.r2!.classA}
            projected={project(data.r2!.classA)}
            limit={1_000_000}
            format={num}
            note="Enviar música nova: 2 por música (MP3 + capa)."
            price={(over) => usd((over / 1_000_000) * 4.5)}
          />
          <Meter
            label="Leituras no mês (Classe B)"
            value={data.r2!.classB}
            projected={project(data.r2!.classB)}
            limit={10_000_000}
            format={num}
            note="Cada aparelho tocando uma música pela primeira vez, e a conferência de cada envio."
            price={(over) => usd((over / 1_000_000) * 0.36)}
          />

          <h3 className="consumption-group">Servidor e banco · não cobram, só param até o dia seguinte</h3>
          <Meter
            label="Pedidos ao servidor no pior dia"
            value={data.workers!.maxDay}
            limit={100_000}
            format={num}
            note={`Hoje: ${num(data.workers!.today)} · no mês: ${num(data.workers!.month)}.`}
          />
          <Meter
            label="Leituras do banco no pior dia"
            value={data.d1Read!.maxDay}
            limit={5_000_000}
            format={num}
            note={`Hoje: ${num(data.d1Read!.today)} linhas lidas.`}
          />
          <Meter
            label="Gravações no banco no pior dia"
            value={data.d1Written!.maxDay}
            limit={100_000}
            format={num}
            note={`Hoje: ${num(data.d1Written!.today)} linhas gravadas.`}
          />
          {!!data.errors?.length && (
            <p className="small error">Alguns números não vieram da Cloudflare: {data.errors.join(" · ")}</p>
          )}
        </>
      )}
    </section>
  );
}

/** Barra de consumo com a linha vermelha no limite grátis. */
function Meter({
  label,
  value,
  limit,
  projected,
  format,
  note,
  price,
}: {
  label: string;
  value: number;
  limit: number;
  projected?: number;
  format: (n: number) => string;
  note?: string;
  /** Quanto custaria o que passar do limite (só para o que cobra). */
  price?: (over: number) => string;
}) {
  const top = Math.max(value, projected ?? 0, limit) * 1.15;
  const at = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  const pct = (value / limit) * 100;
  const tone = value >= limit ? "over" : (projected ?? value) >= limit ? "warn" : pct >= 80 ? "warn" : "ok";
  const overNow = Math.max(0, value - limit);
  const overProjected = Math.max(0, (projected ?? value) - limit);
  return (
    <div className={`meter ${tone}`}>
      <div className="row between meter-head">
        <span>{label}</span>
        <span className="meter-value">
          {format(value)} <span className="muted">de {format(limit)} grátis</span>
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        aria-valuetext={`${format(value)} de ${format(limit)} grátis`}
      >
        {projected !== undefined && projected > value && <div className="meter-projected" style={{ width: at(projected) }} />}
        <div className="meter-fill" style={{ width: at(value) }} />
        <div className="meter-limit" style={{ left: at(limit) }} title={`Começa a cobrar a partir de ${format(limit)}`} />
      </div>
      <p className="small muted">
        {pct < 0.1 && value > 0 ? "menos de 0,1%" : `${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`} do grátis
        {projected !== undefined && ` · previsão do mês: ${format(projected)}`}
        {price && overNow > 0 && <strong className="danger-text"> · já custando {price(overNow)}</strong>}
        {price && !overNow && overProjected > 0 && <strong className="danger-text"> · no ritmo atual custaria {price(overProjected)}</strong>}
        {note && <> · {note}</>}
      </p>
    </div>
  );
}
