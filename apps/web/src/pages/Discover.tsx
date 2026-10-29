import { useEffect, useMemo, useState } from "react";
import type { DiscoverArtist, ImportRequestInfo, ImportTrackStatus, TrackSearchHit } from "@yfitops/core";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { libraryStore, type Library } from "../lib/library";
import { playList } from "../lib/player";
import { previewStore, togglePreview } from "../lib/preview";
import { confirmDialog } from "../lib/dialog";
import { StorageBar } from "../components/StorageBar";
import { TagInput } from "../components/TagInput";
import {
  answerLinkAsk,
  answerLinkPick,
  clearSearch,
  dismissArrived,
  dropRequest,
  finished,
  importsStore,
  isDeezerLink,
  isImportLink,
  isSearchText,
  isSpotifyLink,
  isYouTubeLink,
  requestLink,
  requestPercent,
  requestProgress,
  requestStage,
  requestTrack,
  retryRequest,
  serviceName,
  setImportLink,
  setImportTags,
  skipTracks,
  trackPercent,
  waitsForMyPhone,
} from "../lib/imports";
import { useStore } from "../lib/observable";
import { formatTime } from "../lib/tracks";

/** O embed do Spotify só entrega as 50 primeiras músicas de uma playlist. */
function SpotifyLimit() {
  return (
    <p className="small muted">
      O Spotify só deixa ler as <strong>50 primeiras músicas</strong> da playlist. Se ela tiver
      mais, o resto ficou de fora.
    </p>
  );
}

/**
 * Descobrir: pedir uma música (link ou nome), acompanhar os pedidos e achar
 * músicas novas (as paradas do Deezer e "porque você ouve...").
 */
export function DiscoverPage() {
  // Vem de um store (e não de useState) para sobreviver à troca de tela.
  const { link, sending, error: linkError, ask, pick, tags, requests, results, resultsFor, searching, requested, arrived } = useStore(importsStore);
  const asking = !!pick || ask;
  /** Digitou um nome (e não colou um link): o botão busca em vez de pedir. */
  const searchMode = !isImportLink(link) && isSearchText(link);

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
      <div className={`link-import${brand ? ` linked ${brand}` : ""}`}>
        <label className="link-field">
          <span className="link-brand" aria-hidden="true">
            <Icon name={brand ?? (searchMode ? "search" : "youtube")} size={20} />
          </span>
          <input
            type="text"
            // Sempre os mesmos atributos: trocar o tipo do teclado no meio da digitação
            // (ex.: o botão "Enter" de "ir" para "buscar") reinicia o teclado do Android e apaga o texto.
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Link ou nome da música"
            value={link}
            placeholder="Nome da música ou link"
            disabled={sending || asking}
            onChange={(e) => setImportLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void requestLink()}
          />
        </label>
        <button className="primary" disabled={sending || searching || asking || !link.trim()} onClick={() => void requestLink()}>
          {sending ? "pedindo..." : searching ? "buscando..." : searchMode ? "buscar" : "pedir"}
        </button>
        {linkError && <span className="small err">{linkError}</span>}
      </div>

      {/* Opcional: só aparece com um link válido, com resultados de busca (ou se já houver tags escolhidas). */}
      {(brand || results || tags.length > 0) && (
        <div className="import-tags">
          <span className="muted small">
            Tags para todas as músicas <span className="muted">(opcional)</span>
          </span>
          <TagInput tags={tags} onChange={setImportTags} placeholder="ex.: academia, anos-80…" disabled={sending} />
        </div>
      )}

      {results && <SearchResults hits={results} query={resultsFor} requested={requested} />}

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
            <button className="chip ghost" onClick={() => answerLinkPick(null)}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {ask && (
        <div className="import-result">
          <p>
            Esse link é de uma <strong>playlist</strong> (ou álbum). Quer que as músicas fiquem ligadas a uma playlist no
            app, com o mesmo nome?
          </p>
          {isSpotifyLink(link) && <SpotifyLimit />}
          <div className="import-result-actions">
            <button className="primary" onClick={() => answerLinkAsk(true)}>
              pedir e criar a playlist
            </button>
            <button className="link" onClick={() => answerLinkAsk(false)}>
              só as músicas
            </button>
            <button className="chip ghost" onClick={() => answerLinkAsk(null)}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {(requests.length > 0 || arrived.length > 0) && (
        <>
          <div className="section-head">
            <h2>Seus pedidos</h2>
          </div>
          <ul className="requests">
            {arrived.map((a) => (
              <li key={a.trackId} className="request arrived">
                <div className="request-head">
                  <span className="track-text">
                    <span className="track-title">{a.title}</span>
                    <span className="track-sub">{a.artist ? `${a.artist} · ` : ""}chegou na sua biblioteca</span>
                  </span>
                  <span className="stage done">
                    <Icon name="check" size={14} /> Pronta
                  </span>
                </div>
                <div className="progress big">
                  <div style={{ width: "100%" }} />
                </div>
                <div className="import-result-actions">
                  <button className="primary" onClick={() => playList([a.trackId])}>
                    <Icon name="play" size={14} /> tocar
                  </button>
                  <button className="link" onClick={() => dismissArrived(a.trackId)}>
                    ok
                  </button>
                </div>
              </li>
            ))}
            {requests.map((r) => (
              <RequestCard key={r.id} r={r} />
            ))}
          </ul>
        </>
      )}

      {!results && <DiscoverSections />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Músicas para descobrir
// ---------------------------------------------------------------------------

/** Texto comparável: sem acento, minúsculo, sem o que vem entre parênteses ("(Ao Vivo)"). */
const plainText = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** O primeiro artista ("Henrique & Juliano feat. X" fica "Henrique & Juliano"). */
const mainArtist = (s: string) => s.split(/\s+(?:feat\.?|ft\.?|part\.?|participação)\s+|,/i)[0].trim();

/** "artista|título" de tudo que já está na biblioteca: a música vem com o selo "na biblioteca". */
function ownedKeys(lib: Library): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(lib.tracks)) out.add(`${plainText(mainArtist(t.artist))}|${plainText(t.title)}`);
  return out;
}
const hitKey = (h: TrackSearchHit) => `${plainText(mainArtist(h.artist))}|${plainText(h.title)}`;

/**
 * Artistas que a pessoa mais ouve (pelo histórico deste aparelho e da conta). Sem
 * histórico, os que mais aparecem na biblioteca. Tudo calculado aqui: o servidor
 * só repassa o nome do artista ao Deezer.
 */
function favoriteArtists(lib: Library, limit = 2): string[] {
  const score = new Map<string, { name: string; n: number }>();
  const add = (artist: string, n: number) => {
    const name = mainArtist(artist);
    const key = plainText(name);
    if (!key) return;
    const cur = score.get(key) ?? { name, n: 0 };
    score.set(key, { name: cur.name, n: cur.n + n });
  };
  for (const p of Object.values(lib.plays)) {
    const t = lib.tracks[p.trackId];
    if (t) add(t.artist, 3);
  }
  for (const t of Object.values(lib.tracks)) add(t.artist, t.favoriteAt ? 2 : 1);
  return [...score.values()]
    .filter((a) => a.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((a) => a.name);
}

/** Respostas já buscadas nesta sessão (trocar de tela não pergunta de novo). */
const listCache = new Map<string, TrackSearchHit[]>();
const artistCache = new Map<string, DiscoverArtist>();

function useList(key: string) {
  const [tracks, setTracks] = useState<TrackSearchHit[] | null>(listCache.get(key) ?? null);
  const [error, setError] = useState("");
  useEffect(() => {
    const known = listCache.get(key);
    if (known) return setTracks(known);
    let alive = true;
    setTracks(null);
    setError("");
    api.json<{ tracks: TrackSearchHit[] }>(`/discover/list/${key}`).then(
      (r) => (listCache.set(key, r.tracks), alive && setTracks(r.tracks)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return { tracks, error };
}

function useArtist(name: string) {
  const key = plainText(name);
  const [data, setData] = useState<DiscoverArtist | null>(artistCache.get(key) ?? null);
  useEffect(() => {
    const known = artistCache.get(key);
    if (known) return setData(known);
    let alive = true;
    setData(null);
    api.json<DiscoverArtist>(`/discover/artist?name=${encodeURIComponent(name)}`).then(
      (r) => (artistCache.set(key, r), alive && setData(r)),
      () => alive && setData({ artist: name, tracks: [], related: [] }),
    );
    return () => {
      alive = false;
    };
  }, [key, name]);
  return data;
}

/** As listas do Descobrir (fixas: as mesmas do servidor). */
const LISTS: [string, string][] = [
  ["brasil", "Brasil"],
  ["mundo", "Mundo"],
  ["sertanejo", "Sertanejo"],
  ["funk", "Funk"],
  ["pagode", "Pagode"],
  ["forro", "Forró e piseiro"],
  ["gospel", "Gospel"],
  ["pop", "Pop"],
  ["trap", "Rap e trap"],
  ["internacional", "Internacional"],
  ["rock", "Rock nacional"],
  ["mpb", "MPB"],
  ["eletronica", "Eletrônica"],
];

function DiscoverSections() {
  const lib = useStore(libraryStore);
  const owned = useMemo(() => ownedKeys(lib), [lib.tracks]);
  const artists = useMemo(() => favoriteArtists(lib), [lib.tracks, lib.plays]);
  const [list, setList] = useState(() => sessionStorage.getItem("discoverList") || "brasil");
  const [extra, setExtra] = useState<string | null>(null);
  const choose = (key: string) => {
    setList(key);
    sessionStorage.setItem("discoverList", key);
  };

  return (
    <div className="discover">
      {artists.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Para você</h2>
          </div>
          {artists.map((a) => (
            <ArtistRow key={a} name={a} title={`Porque você ouve ${a}`} owned={owned} picked={extra} onRelated={setExtra} />
          ))}
          {extra && <ArtistRow key={extra} name={extra} title={`Mais de ${extra}`} owned={owned} picked={extra} onRelated={setExtra} />}
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Em alta</h2>
        </div>
        <div className="chips scroll">
          {LISTS.map(([key, name]) => (
            <button key={key} className={`chip${list === key ? " on" : ""}`} onClick={() => choose(key)}>
              {name}
            </button>
          ))}
        </div>
        <ChartList key={list} listKey={list} owned={owned} />
      </section>
    </div>
  );
}

function ChartList({ listKey, owned }: { listKey: string; owned: Set<string> }) {
  const { tracks, error } = useList(listKey);
  const [all, setAll] = useState(false);
  if (error) return <p className="muted small">{error}</p>;
  if (!tracks) return <p className="muted small">Carregando…</p>;
  const shown = all ? tracks : tracks.slice(0, 20);
  return (
    <>
      <HitList hits={shown} owned={owned} numbered />
      {!all && tracks.length > shown.length && (
        <button className="link more" onClick={() => setAll(true)}>
          ver as {tracks.length}
        </button>
      )}
    </>
  );
}

/**
 * Um artista: as mais famosas que a pessoa ainda não tem, em pôsteres rolando para
 * o lado, e logo abaixo os artistas parecidos (tocar num abre a fileira dele).
 */
function ArtistRow({
  name,
  title,
  owned,
  picked,
  onRelated,
}: {
  name: string;
  title: string;
  owned: Set<string>;
  picked: string | null;
  onRelated: (name: string | null) => void;
}) {
  const data = useArtist(name);
  const { requested } = useStore(importsStore);
  if (!data) return <p className="muted small">Carregando…</p>;
  const fresh = data.tracks.filter((h) => !owned.has(hitKey(h))).slice(0, 10);
  if (!fresh.length && !data.related.length) return null;
  return (
    <div className="discover-artist">
      <h3>{title}</h3>
      {fresh.length > 0 ? (
        <div className="posters">
          {fresh.map((h) => (
            <PosterCard key={h.id} hit={h} requested={requested.includes(h.id)} />
          ))}
        </div>
      ) : (
        <p className="muted small">Você já tem as mais famosas.</p>
      )}
      {data.related.length > 0 && (
        <>
          <h4>Parecidos com {data.artist}</h4>
          <div className="artist-pills">
            {data.related.slice(0, 6).map((r) => (
              <button
                key={r.name}
                className={`artist-pill${picked === r.name ? " on" : ""}`}
                onClick={() => onRelated(picked === r.name ? null : r.name)}
              >
                {r.picture ? <img src={r.picture} alt="" loading="lazy" /> : <span className="artist-pill-blank" />}
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Capa do Deezer em tamanho maior (os pôsteres são mais altos que a capa média). */
const bigCover = (url: string) => url.replace(/\/\d+x\d+-/, "/500x500-");

/** Pôster: a capa alta com o nome por cima (tocar ouve a prévia) e o botão de pedir embaixo. */
function PosterCard({ hit: h, requested }: { hit: TrackSearchHit; requested: boolean }) {
  const preview = useStore(previewStore);
  const playing = preview.id === h.id;
  return (
    <div className={`poster${playing ? " previewing" : ""}`}>
      <button
        className="poster-art"
        disabled={!h.preview}
        title={h.preview ? (playing ? "Parar a prévia" : "Ouvir 30 segundos") : undefined}
        onClick={() => void togglePreview(h.id)}
      >
        {h.cover ? <img src={bigCover(h.cover)} alt="" loading="lazy" /> : <span className="poster-blank" />}
        {h.preview && (
          <span className="poster-play">
            <Icon name={playing && !preview.loading ? "pause" : "play"} size={14} />
          </span>
        )}
        <span className="poster-text">
          <span className="poster-title">{h.title}</span>
          <span className="poster-artist">{h.artist}</span>
        </span>
      </button>
      <button className={`chip${requested ? " on" : ""}`} disabled={requested} onClick={() => void requestTrack(h)}>
        {requested ? "pedida" : "pedir"}
      </button>
    </div>
  );
}

function HitList({ hits, owned, numbered }: { hits: TrackSearchHit[]; owned: Set<string>; numbered?: boolean }) {
  const { requested } = useStore(importsStore);
  return (
    <ul className="tracks hits">
      {hits.map((h, i) => (
        <HitRow key={h.id} hit={h} n={numbered ? i + 1 : undefined} owned={owned.has(hitKey(h))} requested={requested.includes(h.id)} />
      ))}
    </ul>
  );
}

/** Uma música para pedir: capa (toca a prévia), nome, e o botão de pedir. */
function HitRow({ hit: h, n, owned, requested }: { hit: TrackSearchHit; n?: number; owned?: boolean; requested: boolean }) {
  const preview = useStore(previewStore);
  const playing = preview.id === h.id;
  return (
    <li className={playing ? "previewing" : undefined}>
      <span className="track-main search-hit">
        {n !== undefined && <span className="hit-n muted">{n}</span>}
        <button
          className="hit-cover"
          disabled={!h.preview}
          title={h.preview ? (playing ? "Parar a prévia" : "Ouvir 30 segundos") : "Sem prévia"}
          onClick={() => void togglePreview(h.id)}
        >
          {h.cover ? <img className="search-cover" src={h.cover} alt="" loading="lazy" /> : <span className="search-cover blank" />}
          {h.preview && (
            <span className="hit-play">
              <Icon name={playing && !preview.loading ? "pause" : "play"} size={18} />
            </span>
          )}
        </button>
        <span className="track-text">
          <span className="track-title">{h.title}</span>
          <span className="track-sub">{[h.artist, h.album].filter(Boolean).join(" · ")}</span>
        </span>
        {h.duration > 0 && <span className="track-time">{formatTime(h.duration)}</span>}
      </span>
      {owned ? (
        <span className="chip on static" title="Já está na sua biblioteca">
          <Icon name="check" size={14} /> tem
        </span>
      ) : (
        <button className={`chip${requested ? " on" : ""}`} disabled={requested} onClick={() => void requestTrack(h)}>
          {requested ? "pedida" : "pedir"}
        </button>
      )}
    </li>
  );
}

/** Músicas achadas pelo nome: a pessoa escolhe a certa e pede (vai para a fila como qualquer link). */
function SearchResults({ hits, query, requested }: { hits: TrackSearchHit[]; query: string; requested: string[] }) {
  return (
    <section className="search-results">
      <div className="section-head">
        <p className="muted small">
          {hits.length
            ? `Músicas para "${query}". Toque na capa para ouvir um trecho e em pedir na certa.`
            : `Nada encontrado para "${query}". Tente com o nome do artista junto, ou cole um link.`}
        </p>
        <button className="link" onClick={clearSearch}>
          fechar
        </button>
      </div>
      {hits.length > 0 && (
        <ul className="tracks hits">
          {hits.map((h) => (
            <HitRow key={h.id} hit={h} requested={requested.includes(h.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

const TRACK_STATUS: Record<ImportTrackStatus, string> = {
  queued: "na fila",
  working: "baixando agora",
  done: "pronta",
  failed: "não deu",
  skipped: "ignorada",
};

/** Um link pedido: andamento, as músicas e o que dá para fazer com ele. */
function RequestCard({ r }: { r: ImportRequestInfo }) {
  const [open, setOpen] = useState(false);
  const { helpers } = useStore(importsStore);
  const done = finished(r);
  const stage = requestStage(r, helpers);
  const pct = requestPercent(r);
  const failed = r.tracks.filter((t) => t.status === "failed");
  const queued = r.tracks.filter((t) => t.status === "queued");
  const title = r.name || (r.tracks.length === 1 ? r.tracks[0].meta.title : "") || `Link do ${serviceName(r.url)}`;
  const cancel = async () => {
    const ok = await confirmDialog({
      title: "Cancelar o pedido?",
      message: "O que ainda não foi baixado não será. O que já chegou continua na sua biblioteca.",
      confirm: "cancelar pedido",
      danger: true,
    });
    if (ok) void dropRequest(r);
  };
  return (
    <li className={`request${r.status === "failed" || failed.length ? " has-err" : ""}`}>
      <div className="request-head">
        <span className="track-text">
          <span className="track-title">{title}</span>
          <span className={`track-sub${r.status === "failed" ? " err" : ""}`}>
            {r.tracks.length > 1 || done ? requestProgress(r) : stage.hint}
          </span>
        </span>
        {!done && (
          <span className={`stage${stage.working ? " working" : ""}`}>
            {stage.label}
            {stage.working && ` ${pct}%`}
          </span>
        )}
      </div>
      {!done && (
        <div className={`progress big${stage.working ? " working" : " waiting"}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {!done && r.tracks.length > 1 && <span className="muted small">{stage.hint}</span>}
      {r.tracks.length > 1 && (
        <button className="link left" onClick={() => setOpen(!open)}>
          {open ? "esconder as músicas" : `ver as ${r.tracks.length} músicas`}
        </button>
      )}
      {r.truncated && r.provider === "spotify" && <SpotifyLimit />}
      {open && (
        <ul className="request-tracks">
          {r.tracks.map((t, i) => (
            <li key={t.id} className={t.status}>
              <span className="track-text">
                <span className="track-title">
                  {i + 1}. {t.meta.title}
                </span>
                <span className={`track-sub${t.status === "failed" ? " err" : ""}`}>
                  {waitsForMyPhone(t)
                    ? "esperando o seu celular Android (mais de 13 minutos: fica só nele)"
                    : t.status === "working"
                      ? `baixando ${trackPercent(t)}%`
                      : TRACK_STATUS[t.status]}
                  {t.error && (t.status === "failed" || t.status === "skipped") && ` · ${t.error}`}
                </span>
              </span>
              {t.status === "queued" && (
                <button className="icon-btn" title="Não baixar esta" onClick={() => void skipTracks(r, [t.id])}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="import-result-actions">
        {done && (failed.length > 0 || r.status === "failed") && (
          <button className="primary" onClick={() => void retryRequest(r)}>
            tentar de novo{failed.length ? ` (${failed.length})` : ""}
          </button>
        )}
        {queued.length > 1 && (
          <button className="link" onClick={() => void skipTracks(r, queued.map((t) => t.id))}>
            ignorar as {queued.length} que faltam
          </button>
        )}
        {done ? (
          <button className="link" onClick={() => void dropRequest(r)}>
            dispensar
          </button>
        ) : (
          <button className="chip ghost" onClick={() => void cancel()}>
            cancelar
          </button>
        )}
      </div>
    </li>
  );
}
