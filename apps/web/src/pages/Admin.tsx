import { useCallback, useEffect, useState } from "react";
import type { SongInfo } from "@yfitops/core";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { brl, brlInput, daysLeft, dueText, formatDate, formatPhone, inviteLink, parseBrl, WARN_DAYS } from "../lib/billing";
import { coverRef } from "../lib/catalog";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { refreshAccount } from "../lib/session";
import { formatBytes, formatTime, musicas } from "../lib/tracks";
import { attempt, toast } from "../lib/ui";
import { refreshUsage } from "../lib/usage";

// Painel administrativo. Só é carregado para quem é administrador (o servidor
// diz quem é); para os outros, esta tela nem é baixada.

interface AdminUser {
  id: string;
  email: string;
  status: "approved" | "pending";
  createdAt: number;
  /** Músicas que essa pessoa pediu (não quem baixou) e o espaço delas. */
  songs: number;
  bytes: number;
  lastLogin: number | null;
  admin: boolean;
  me: boolean;
  phone: string | null;
  /** Acesso pago até (ms). */
  paidUntil: number;
  /** Pode buscar no catálogo inteiro. */
  catalog: boolean;
  /** Mensalidade combinada com a pessoa (centavos); null = a padrão. */
  priceCents: number | null;
  /** Está no programa de indicação. */
  referral: boolean;
  /** Conta de celular ajudante: não vence e não é cliente. */
  helper: boolean;
  referralCode: string | null;
  /** E-mail de quem indicou. */
  referredBy: string | null;
  /** Quantas pessoas chegaram pelo link dela. */
  referrals: number;
}

interface Prices {
  /** Mensalidade padrão (centavos). */
  priceCents: number;
  /** Quanto quem indica ganha por indicado que pagar (centavos). */
  rewardCents: number;
}

interface Overview {
  usage: { bytes: number; quota: number; count: number };
  /** Contas que ainda não abriram o app desde a faxina de músicas sem dono (até lá, ela não apaga nada). */
  ownersWaiting: string[];
  users: AdminUser[];
  prices: Prices;
}

const MONTH_OPTIONS = [1, 2, 3, 6, 12];

/** Mensalidade que vale para a pessoa. */
const priceOf = (u: AdminUser, p: Prices) => u.priceCents ?? p.priceCents;

const months = (n: number) => `${n} ${n === 1 ? "mês" : "meses"}`;

/** Copia um texto; sem permissão, mostra para copiar à mão. */
async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copiado`);
  } catch {
    await promptDialog({ title: what, input: { value: text }, confirm: "ok" });
  }
}

/** Link do WhatsApp com a mensagem de cobrança pronta (o Pix você manda na conversa). */
function whatsappLink(u: AdminUser, price: number): string | null {
  if (!u.phone) return null;
  const when = formatDate(u.paidUntil);
  const value = price ? ` São ${brl(price)} por mês.` : "";
  const text =
    u.paidUntil < Date.now()
      ? `Oi! Seu acesso ao Yfitops venceu em ${when}. Quer renovar?${value} Te mando o Pix por aqui.`
      : `Oi! Seu acesso ao Yfitops vence em ${when}. Quer renovar?${value} Te mando o Pix por aqui.`;
  return `https://wa.me/${u.phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/**
 * Cobrança de uma pessoa: mensalidade, registrar pagamento (libera os meses), bloquear,
 * cobrar, o acesso ao catálogo e o programa de indicação.
 */
/** Conta só para um celular baixar os pedidos: sem cobrança. */
function HelperAccount({ u, onChange }: { u: AdminUser; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="admin-billing">
      <small className="tone-text-ok">celular ajudante · não vence e não entra na cobrança</small>
      <small className="muted">No celular, entre com esta conta e ligue em Ajustes → Celular ajudante (24 horas).</small>
      <span className="row wrap admin-actions">
        <HelperToggle u={u} busy={busy} setBusy={setBusy} onChange={onChange} />
      </span>
    </div>
  );
}

function HelperToggle({
  u,
  busy,
  setBusy,
  onChange,
}: {
  u: AdminUser;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [on, setOn] = useState(u.helper);
  return (
    <label className="admin-toggle" title="Conta só para um celular que baixa os pedidos de todos, 24 horas">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => {
          const allowed = e.target.checked;
          setOn(allowed);
          void attempt(async () => {
            setBusy(true);
            try {
              await api.json(`/admin/users/${u.id}/helper`, { method: "POST", json: { allowed } });
              await onChange();
            } finally {
              setBusy(false);
            }
          }, allowed ? `${u.email} agora é celular ajudante` : `${u.email} voltou a ser uma conta normal`);
        }}
      />
      celular ajudante
    </label>
  );
}

function Billing({ u, prices, onChange }: { u: AdminUser; prices: Prices; onChange: () => Promise<void> }) {
  const price = priceOf(u, prices);
  const [count, setCount] = useState(1);
  const [amount, setAmount] = useState(brlInput(price));
  const [catalog, setCatalog] = useState(u.catalog);
  const [referral, setReferral] = useState(u.referral);
  const [busy, setBusy] = useState(false);
  // O valor já vem com a mensalidade vezes os meses; dá para mudar (desconto, cortesia = 0).
  useEffect(() => setAmount(brlInput(price * count)), [price, count]);
  const now = Date.now();
  const expired = u.paidUntil < now;
  const tone = expired ? "error" : daysLeft(u.paidUntil, now) <= WARN_DAYS ? "warn" : "ok";
  const wa = whatsappLink(u, price);

  const run = (fn: () => Promise<unknown>, ok: string) =>
    attempt(async () => {
      setBusy(true);
      try {
        await fn();
        await onChange();
      } finally {
        setBusy(false);
      }
    }, ok);

  const register = () => {
    const cents = parseBrl(amount);
    if (cents === null) return toast("Valor inválido. Use, por exemplo, 25,90", "error");
    void run(
      () => api.json(`/admin/users/${u.id}/access`, { method: "POST", json: { months: count, amountCents: cents } }),
      cents ? `${brl(cents)} registrado: ${months(count)} para ${u.email}` : `${months(count)} de cortesia para ${u.email}`,
    );
  };

  const changePrice = async () => {
    const v = await promptDialog({
      title: `Mensalidade de ${u.email}`,
      message: `Quanto essa pessoa paga por mês. Deixe vazio para usar a padrão (${brl(prices.priceCents)}).`,
      input: { value: u.priceCents === null ? "" : brlInput(u.priceCents), placeholder: brlInput(prices.priceCents) },
      confirm: "salvar",
    });
    if (v === null) return;
    const priceCents = v.trim() ? parseBrl(v) : null;
    if (v.trim() && priceCents === null) return toast("Valor inválido. Use, por exemplo, 25,90", "error");
    void run(() => api.json(`/admin/users/${u.id}/price`, { method: "PUT", json: { priceCents } }), "Mensalidade salva");
  };

  return (
    <div className="admin-billing">
      <small className={`tone-text-${tone}`}>
        {expired ? `vencido em ${formatDate(u.paidUntil)}` : `pago até ${formatDate(u.paidUntil)} (vence ${dueText(u.paidUntil, now)})`}
      </small>
      <small className="muted">
        mensalidade <strong className="money">{price ? brl(price) : "sem valor"}</strong>
        {u.priceCents === null && " (padrão)"}{" "}
        <button className="link" disabled={busy} onClick={() => void changePrice()}>
          mudar
        </button>
      </small>
      <span className="row wrap admin-actions">
        <select value={count} disabled={busy} onChange={(e) => setCount(Number(e.target.value))} aria-label="Meses a liberar">
          {MONTH_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {months(m)}
            </option>
          ))}
        </select>
        <label className="admin-amount">
          R$
          <input inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} aria-label="Valor recebido" />
        </label>
        <button className="chip" disabled={busy} onClick={register}>
          registrar pagamento
        </button>
        {wa && (
          <a className="chip ghost" href={wa} target="_blank" rel="noreferrer">
            cobrar no WhatsApp
          </a>
        )}
        {!expired && (
          <button
            className="link danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Bloquear agora?",
                message: `${u.email} perde o acesso na hora. Volta quando você liberar meses de novo. Nada da biblioteca é apagado.`,
                confirm: "bloquear",
                danger: true,
              });
              if (ok) void run(() => api.json(`/admin/users/${u.id}/access`, { method: "POST", json: { block: true } }), "Acesso bloqueado");
            }}
          >
            bloquear
          </button>
        )}
      </span>
      <span className="row wrap admin-actions">
        <label className="admin-toggle" title="Deixa essa pessoa buscar todas as músicas do servidor">
          <input
            type="checkbox"
            checked={catalog}
            disabled={busy}
            onChange={(e) => {
              const allowed = e.target.checked;
              setCatalog(allowed);
              void run(
                () => api.json(`/admin/users/${u.id}/catalog`, { method: "POST", json: { allowed } }),
                allowed ? `${u.email} agora vê o catálogo` : `${u.email} não vê mais o catálogo`,
              );
            }}
          />
          vê o catálogo
        </label>
        <label className="admin-toggle" title="Dá a essa pessoa um link de convite: ela ganha por quem entrar e pagar">
          <input
            type="checkbox"
            checked={referral}
            disabled={busy}
            onChange={(e) => {
              const on = e.target.checked;
              setReferral(on);
              void run(
                () => api.json(`/admin/users/${u.id}/referral`, { method: "POST", json: { on } }),
                on ? `${u.email} agora pode indicar` : `${u.email} saiu das indicações`,
              );
            }}
          />
          pode indicar
        </label>
        <HelperToggle u={u} busy={busy} setBusy={setBusy} onChange={onChange} />
        {u.referral && u.referralCode && (
          <button className="link" onClick={() => void copyText(inviteLink(u.referralCode!), "Link de convite")}>
            copiar link de convite
          </button>
        )}
      </span>
    </div>
  );
}

type AdminSong = SongInfo & { createdAt: number; requestedBy: string | null };

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "nunca");

type Tab = "pessoas" | "dinheiro" | "sistema";
const TABS: [Tab, string][] = [
  ["pessoas", "Pessoas"],
  ["dinheiro", "Dinheiro"],
  ["sistema", "Sistema"],
];

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem("adminTab") as Tab) || "pessoas";
    } catch {
      return "pessoas";
    }
  });
  const choose = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem("adminTab", t);
    } catch {
      /* só não lembra a aba */
    }
  };

  const load = useCallback(async () => {
    setData(await api.json<Overview>("/admin/overview"));
    void refreshAccount(); // atualiza o número de pedidos no menu
  }, []);

  useEffect(() => {
    void attempt(load);
  }, [load]);

  if (!data) return <div className="page muted">Carregando…</div>;
  const pending = data.users.filter((u) => u.status === "pending").length;

  return (
    <div className="page settings admin">
      <div className="tabs admin-tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => choose(t)}>
            {label}
            {t === "pessoas" && pending > 0 && <span className="dot">{pending}</span>}
          </button>
        ))}
      </div>
      {tab === "pessoas" && <People data={data} onChange={load} />}
      {tab === "dinheiro" && <Money prices={data.prices} onChange={load} />}
      {tab === "sistema" && (
        <>
          <Cloud data={data} onChange={load} />
          <Consumption />
          <CatalogAdmin onChange={load} />
        </>
      )}
    </div>
  );
}

type PeopleFilter = "todas" | "vencendo" | "vencidas" | "indicadoras";

/** Pedidos de acesso (com quem indicou) e as pessoas, com busca e filtros. */
function People({ data, onChange }: { data: Overview; onChange: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("todas");
  const pending = data.users.filter((u) => u.status === "pending");
  const now = Date.now();
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const people = data.users
    .filter((u) => u.status !== "pending")
    .filter((u) => {
      const text = `${u.email} ${u.phone ?? ""} ${formatPhone(u.phone)} ${u.referredBy ?? ""}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) return false;
      if (filter === "vencidas") return !u.admin && u.paidUntil < now;
      if (filter === "vencendo") return !u.admin && u.paidUntil >= now && daysLeft(u.paidUntil, now) <= WARN_DAYS;
      if (filter === "indicadoras") return u.referral;
      return true;
    });

  const approve = (u: AdminUser) =>
    attempt(async () => (await api.json(`/admin/users/${u.id}/approve`, { method: "POST" }), onChange()), `${u.email} pode entrar`);

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
            message: `A conta de ${u.email} é apagada, com biblioteca e playlists. As músicas que essa pessoa pediu continuam no catálogo.`,
            confirm: "apagar conta",
            danger: true,
          },
    );
    if (ok) await attempt(async () => (await api.json(`/admin/users/${u.id}`, { method: "DELETE" }), onChange()), pendingRequest ? "Pedido recusado" : "Conta apagada");
  };

  return (
    <>
      <section>
        <h2>Pedidos de acesso</h2>
        {pending.length ? (
          <ul className="plain admin-list">
            {pending.map((u) => (
              <li key={u.id}>
                <span className="admin-who">
                  <strong>{u.email}</strong>
                  <small className="muted">
                    pediu em {date(u.createdAt)}
                    {u.phone && ` · ${formatPhone(u.phone)}`}
                  </small>
                  {u.referredBy ? (
                    <small className="referred-by">indicado por {u.referredBy}</small>
                  ) : (
                    <small className="muted">sem indicação</small>
                  )}
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
        <h2>Pessoas</h2>
        <div className="admin-filters">
          <input className="search-input" type="search" placeholder="E-mail, celular ou quem indicou" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="segmented" role="radiogroup" aria-label="Mostrar">
            {(["todas", "vencendo", "vencidas", "indicadoras"] as const).map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {people.length ? (
          <ul className="plain admin-list">
            {people.map((u) => (
              <li key={u.id}>
                <span className="admin-who">
                  <strong>
                    {u.email}
                    {u.me && <span className="muted"> (você)</span>}
                  </strong>
                  <small className="muted">
                    {u.phone ? `${formatPhone(u.phone)} · ` : ""}desde {date(u.createdAt)} · último acesso {date(u.lastLogin)} · pediu {musicas(u.songs)} (
                    {formatBytes(u.bytes)})
                  </small>
                  {(u.referredBy || u.referral) && (
                    <small className="referred-by">
                      {u.referredBy && `indicado por ${u.referredBy}`}
                      {u.referredBy && u.referral && " · "}
                      {u.referral && `indicadora · ${u.referrals === 1 ? "1 indicado" : `${u.referrals} indicados`}`}
                    </small>
                  )}
                  {!u.admin &&
                    (u.helper ? <HelperAccount u={u} onChange={onChange} /> : <Billing u={u} prices={data.prices} onChange={onChange} />)}
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
        ) : (
          <p className="muted small">Ninguém por aqui.</p>
        )}
      </section>
    </>
  );
}

/** Espaço da nuvem e a faxina. */
function Cloud({ data, onChange }: { data: Overview; onChange: () => Promise<void> }) {
  const pct = Math.min(100, (data.usage.bytes / data.usage.quota) * 100);
  return (
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
            await onChange();
            void refreshUsage();
            return r;
          }, "Faxina feita")
        }
      >
        juntar duplicadas agora
      </button>
      <p className="muted small">
        A faxina também roda sozinha todo dia de madrugada. Ela junta duplicadas e apaga músicas que ninguém tem na biblioteca há
        mais de 3 dias.
      </p>
      {data.ownersWaiting.length > 0 && (
        <p className="small tone-text-warn">
          Músicas sem dono ainda não são apagadas: falta {data.ownersWaiting.length === 1 ? "esta pessoa abrir" : "estas pessoas abrirem"} o
          app pelo menos uma vez: {data.ownersWaiting.join(", ")}.
        </p>
      )}
    </section>
  );
}

// ---------------- Dinheiro ----------------

type RewardStatus = "waiting" | "available" | "paid" | "canceled";

interface MoneyData {
  thisMonthCents: number;
  lastMonthCents: number;
  /** Soma das mensalidades de quem está com o acesso em dia. */
  expectedCents: number;
  payingCount: number;
  payments: { id: string; email: string; amountCents: number; months: number; createdAt: number; refundedAt: number | null }[];
  referrers: {
    id: string;
    email: string;
    phone: string | null;
    waitingCents: number;
    availableCents: number;
    paidCents: number;
    items: {
      email: string;
      amountCents: number;
      status: RewardStatus;
      paidOn: number;
      availableAt: number;
      paidAt: number | null;
      cancelReason: string | null;
    }[];
  }[];
}

function rewardText(r: MoneyData["referrers"][number]["items"][number]): string {
  switch (r.status) {
    case "waiting":
      return `pagou em ${formatDate(r.paidOn)} · libera em ${formatDate(r.availableAt)}`;
    case "available":
      return "liberado para pagar";
    case "paid":
      return `pago em ${formatDate(r.paidAt ?? 0)}`;
    case "canceled":
      return `cancelado (${r.cancelReason ?? "sem motivo"})`;
  }
}

/** O que entrou, o que deve entrar, os valores, o que pagar a quem indica e os pagamentos. */
function Money({ prices, onChange }: { prices: Prices; onChange: () => Promise<void> }) {
  const [data, setData] = useState<MoneyData | null>(null);
  const load = useCallback(async () => setData(await api.json<MoneyData>("/admin/money")), []);
  useEffect(() => {
    void attempt(load);
  }, [load]);
  const reload = async () => {
    await load();
    await onChange();
  };

  const pay = async (r: MoneyData["referrers"][number]) => {
    const ok = await confirmDialog({
      title: `Já pagou ${brl(r.availableCents)}?`,
      message: `Faça o Pix para ${r.email} primeiro. Aqui só fica marcado como pago, e some do "a pagar".`,
      confirm: "marcar como pago",
    });
    if (ok) await attempt(async () => (await api.json(`/admin/referrers/${r.id}/pay`, { method: "POST" }), reload()), "Marcado como pago");
  };

  const refund = async (p: MoneyData["payments"][number]) => {
    const ok = await confirmDialog({
      title: "Estornar este pagamento?",
      message: `${brl(p.amountCents)} de ${p.email} deixa de contar. Se for o último pagamento dessa pessoa, o vencimento volta para antes dele. Se alguém indicou essa pessoa e ainda não recebeu, a comissão cai.`,
      confirm: "estornar",
      danger: true,
    });
    if (ok) await attempt(async () => (await api.json(`/admin/payments/${p.id}/refund`, { method: "POST" }), reload()), "Pagamento estornado");
  };

  return (
    <>
      <section>
        <h2>Resumo</h2>
        {data ? (
          <div className="money-cards">
            <div className="money-card">
              <small className="muted">Recebido neste mês</small>
              <strong>{brl(data.thisMonthCents)}</strong>
            </div>
            <div className="money-card">
              <small className="muted">Mês passado</small>
              <strong>{brl(data.lastMonthCents)}</strong>
            </div>
            <div className="money-card">
              <small className="muted">Por mês, com quem está em dia</small>
              <strong>{brl(data.expectedCents)}</strong>
              <small className="muted">{data.payingCount === 1 ? "1 pessoa" : `${data.payingCount} pessoas`}</small>
            </div>
          </div>
        ) : (
          <p className="muted small">Carregando…</p>
        )}
      </section>

      <PricesForm prices={prices} onSaved={reload} />

      <section>
        <h2>Indicações</h2>
        <p className="muted small">
          Quem indica ganha {prices.rewardCents ? brl(prices.rewardCents) : "o valor por indicado"} quando o indicado paga a primeira mensalidade.
          O valor fica guardado por 30 dias e cai se o pagamento for estornado, a pessoa for bloqueada ou a conta for apagada nesse tempo.
          Para alguém poder indicar, marque <strong>pode indicar</strong> na pessoa, em Pessoas.
        </p>
        {data && data.referrers.length > 0 ? (
          <ul className="plain admin-list">
            {data.referrers.map((r) => (
              <li key={r.id}>
                <span className="admin-who">
                  <strong>{r.email}</strong>
                  <small>
                    a pagar <strong className={r.availableCents ? "tone-text-ok" : ""}>{brl(r.availableCents)}</strong> · guardado{" "}
                    {brl(r.waitingCents)} · já pago {brl(r.paidCents)}
                  </small>
                  <details className="small">
                    <summary>ver indicados ({r.items.length})</summary>
                    <ul className="plain referral-people">
                      {r.items.map((it, i) => (
                        <li key={i}>
                          <span>
                            {it.email} · {brl(it.amountCents)}
                          </span>
                          <span className="muted">{rewardText(it)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </span>
                {r.availableCents > 0 && (
                  <span className="row wrap">
                    {r.phone && (
                      <a
                        className="chip ghost"
                        href={`https://wa.me/${r.phone.replace(/\D/g, "")}?text=${encodeURIComponent(
                          `Oi! Suas indicações do Yfitops renderam ${brl(r.availableCents)}. Vou te mandar por Pix.`,
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        avisar no WhatsApp
                      </a>
                    )}
                    <button className="primary" onClick={() => void pay(r)}>
                      marcar como pago
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          data && <p className="muted small">Nenhum indicado pagou ainda.</p>
        )}
      </section>

      <section>
        <h2>Pagamentos</h2>
        {data && data.payments.length > 0 ? (
          <ul className="plain admin-list payments">
            {data.payments.map((p) => (
              <li key={p.id} className={p.refundedAt ? "refunded" : ""}>
                <span className="admin-who">
                  <strong>
                    {p.amountCents ? brl(p.amountCents) : "cortesia"} <span className="muted">· {months(p.months)}</span>
                  </strong>
                  <small className="muted">
                    {p.email} · {date(p.createdAt)}
                    {p.refundedAt && ` · estornado em ${date(p.refundedAt)}`}
                  </small>
                </span>
                {!p.refundedAt && (
                  <button className="link danger" onClick={() => void refund(p)}>
                    estornar
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          data && <p className="muted small">Nenhum pagamento registrado ainda. Eles aparecem aqui quando você registra um pagamento em Pessoas.</p>
        )}
      </section>
    </>
  );
}

/** Mensalidade padrão e valor por indicado. */
function PricesForm({ prices, onSaved }: { prices: Prices; onSaved: () => Promise<void> }) {
  const [price, setPrice] = useState(brlInput(prices.priceCents));
  const [reward, setReward] = useState(brlInput(prices.rewardCents));
  const [busy, setBusy] = useState(false);
  const save = () => {
    const priceCents = parseBrl(price);
    const rewardCents = parseBrl(reward);
    if (priceCents === null || rewardCents === null) return toast("Valor inválido. Use, por exemplo, 25,90", "error");
    void attempt(async () => {
      setBusy(true);
      try {
        await api.json("/admin/settings", { method: "PUT", json: { priceCents, rewardCents } });
        await onSaved();
      } finally {
        setBusy(false);
      }
    }, "Valores salvos");
  };
  return (
    <section>
      <h2>Valores</h2>
      <div className="row wrap admin-prices">
        <label className="admin-amount">
          <span>Mensalidade padrão</span>
          R$
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="admin-amount">
          <span>Valor por indicado</span>
          R$
          <input inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} />
        </label>
        <button className="primary" disabled={busy} onClick={save}>
          salvar
        </button>
      </div>
      <p className="muted small">
        A mensalidade padrão vale para quem não tem uma combinada (mude em Pessoas → mensalidade → mudar). Mudar o valor por indicado não muda o
        que já foi ganho.
      </p>
    </section>
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
                    {s.artist} · {formatTime(s.duration)} · {formatBytes(s.size + s.coverSize)} · pediu: {s.requestedBy ?? "conta apagada"} · {date(s.createdAt)}
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
