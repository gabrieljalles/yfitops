import { libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { setFavorite } from "../lib/tracks";
import { attempt } from "../lib/ui";
import { Icon } from "./Icon";

/** Coração de favorita. Some nas músicas compartilhadas (não são suas). */
export function FavoriteButton({ id, size = 20, className = "icon-btn" }: { id: string; size?: number; className?: string }) {
  const lib = useStore(libraryStore);
  const t = lib.tracks[id];
  if (!t) return null;
  const on = !!t.favoriteAt;
  return (
    <button
      className={`${className} fav-btn${on ? " on" : ""}`}
      title={on ? "Tirar das favoritas" : "Favoritar"}
      aria-label={on ? "Tirar das favoritas" : "Favoritar"}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        void attempt(() => setFavorite([id], !on));
      }}
    >
      <Icon name={on ? "heartFilled" : "heart"} size={size} />
    </button>
  );
}
