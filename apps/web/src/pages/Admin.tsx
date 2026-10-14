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
              {!u.admin && (
                <button className="link danger" onClick={() => void remove(u, false)}>
                  tirar acesso
                </button>
              )}
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

  const remove = async (s: AdminSong) => {
    const ok = await confirmDialog({
      title: "Apagar do sistema?",
      message: `"${s.title}" sai da nuvem e da biblioteca de todo mundo. Não dá para desfazer.`,
      confirm: "apagar",
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      await api.json(`/admin/songs/${s.id}`, { method: "DELETE" });
      setSongs((cur) => cur.filter((x) => x.id !== s.id));
      await onChange();
      void refreshUsage();
    }, "Música apagada do sistema");
  };

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
      {songs.length ? (
        <ul className="tracks admin-songs">
          {songs.map((s) => (
            <li key={s.id}>
              <div className="track-main">
                <Cover cover={coverRef(s)} seed={s.title + s.artist} size={44} />
                <span className="track-text">
                  <span className="track-title">{s.title}</span>
                  <span className="track-sub">
                    {s.artist} · {formatTime(s.duration)} · {formatBytes(s.size + s.coverSize)} · {s.uploadedBy ?? "conta apagada"} · {date(s.createdAt)}
                  </span>
                </span>
              </div>
              <button className="icon-btn danger" title="Apagar do sistema" onClick={() => void remove(s)}>
                <Icon name="trash" size={18} />
              </button>
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
