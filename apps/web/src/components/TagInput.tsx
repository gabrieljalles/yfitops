import { useState } from "react";
import { libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { allTags, normalizeTag } from "../lib/search";
import { Icon } from "./Icon";

/**
 * Campo de tags em chips: Enter ou vírgula adiciona, clicar no chip remove, e
 * sugere as tags que já existem na biblioteca.
 */
export function TagInput({
  tags,
  onChange,
  placeholder = "adicionar tag…",
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const lib = useStore(libraryStore);
  const [input, setInput] = useState("");
  const suggestions = allTags(Object.values(lib.tracks))
    .filter((t) => !tags.includes(t) && t.startsWith(normalizeTag(input)))
    .slice(0, 6);

  const add = (raw: string) => {
    const fresh = [...new Set(raw.split(",").map(normalizeTag))].filter((t) => t && !tags.includes(t));
    if (fresh.length) onChange([...tags, ...fresh]);
    setInput("");
  };

  return (
    <>
      <div className="chips">
        {tags.map((tag) => (
          <button
            key={tag}
            className="chip on"
            title="Remover tag"
            disabled={disabled}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            #{tag} <Icon name="close" size={12} />
          </button>
        ))}
        <input
          className="chip-input"
          placeholder={placeholder}
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            }
          }}
          onBlur={() => input && add(input)}
        />
      </div>
      {!disabled && suggestions.length > 0 && (
        <div className="chips suggestions">
          {suggestions.map((s) => (
            <button key={s} className="chip ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => add(s)}>
              #{s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
