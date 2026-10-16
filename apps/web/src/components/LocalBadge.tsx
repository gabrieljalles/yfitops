import type { ReactNode } from "react";

/** Explicação da música que ficou só no aparelho (mostrada no player em cinza clarinho). */
export const LOCAL_NOTE = "Não foi enviada ao servidor por ter mais de 13 minutos: só toca neste celular.";

/**
 * Capa com o selo "local" no cantinho, para músicas que ficaram só neste aparelho
 * (mais de 13 minutos não vão para o servidor). Sem `local`, é só a capa.
 */
export function WithLocalBadge({ local, children }: { local?: boolean; children: ReactNode }) {
  if (!local) return <>{children}</>;
  return (
    <span className="local-wrap">
      {children}
      <span className="local-badge" title={LOCAL_NOTE}>
        local
      </span>
    </span>
  );
}
