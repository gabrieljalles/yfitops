import { useEffect, useRef, useState } from "react";
import { answerDialog, dialogStore } from "../lib/dialog";
import { useStore } from "../lib/observable";

/** Mostra o diálogo pedido por confirmDialog()/promptDialog(). Fica no App. */
export function Dialog() {
  const d = useStore(dialogStore);
  return d ? <DialogBox key={d.title + (d.message ?? "")} /> : null;
}

function DialogBox() {
  const d = useStore(dialogStore)!;
  const [value, setValue] = useState(d.input?.value ?? "");
  const input = useRef<HTMLInputElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const asking = !!d.input;

  useEffect(() => {
    // Ação destrutiva: o foco começa no "cancelar", para um Enter sem querer não apagar nada.
    (asking ? input : d.danger ? cancelBtn : confirmBtn).current?.focus();
    if (asking) input.current?.select();
    // Na captura, para o Esc fechar só o diálogo (e não a ficha da música por baixo).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      answerDialog(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const confirm = () => {
    if (asking && !value.trim()) return;
    answerDialog(asking ? value : "");
  };

  return (
    <div className="dialog-backdrop" onClick={() => answerDialog(null)}>
      <div
        className="dialog"
        role={d.danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="dialog-title">{d.title}</h3>
        {d.message && <p className="muted">{d.message}</p>}
        {asking && (
          <input
            ref={input}
            className="dialog-input"
            type={d.input!.type ?? "text"}
            value={value}
            placeholder={d.input!.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
          />
        )}
        <div className="dialog-actions">
          <button ref={cancelBtn} className="chip ghost" onClick={() => answerDialog(null)}>
            cancelar
          </button>
          <button
            ref={confirmBtn}
            className={d.danger ? "primary danger" : "primary"}
            disabled={asking && !value.trim()}
            onClick={confirm}
          >
            {d.confirm ?? "ok"}
          </button>
        </div>
      </div>
    </div>
  );
}
