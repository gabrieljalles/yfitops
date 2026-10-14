import { describe, expect, it } from "vitest";
import { mainArtist, matchKey, titleKey } from "../src/catalog";

describe("catálogo: comparação de nomes", () => {
  it("ignora acentos, maiúsculas e enfeites de vídeo", () => {
    expect(matchKey("Chitãozinho & Xororó", "Evidências (Official Video)")).toBe(matchKey("chitaozinho e xororo", "EVIDENCIAS [HD]"));
    expect(titleKey("Shape of You [Official Music Video]")).toBe(titleKey("Shape of You (Lyrics)"));
    expect(titleKey("Shape of You - Official Audio")).toBe(titleKey("Shape of You"));
  });

  it("mantém versões diferentes separadas", () => {
    expect(titleKey("Evidências (Ao Vivo)")).toBe(titleKey("Evidências - Ao Vivo"));
    expect(titleKey("Evidências (Ao Vivo)")).not.toBe(titleKey("Evidências"));
    expect(titleKey("Evidências (Acústico)")).not.toBe(titleKey("Evidências (Ao Vivo)"));
    expect(titleKey("Song (Alok Remix)")).not.toBe(titleKey("Song (Vintage Culture Remix)"));
    expect(titleKey("Song (Alok Remix)")).toBe(titleKey("Song - Alok Remix"));
    expect(titleKey("Live Forever")).not.toBe(titleKey("Live Forever (Live)"));
  });

  it("usa só o artista principal", () => {
    expect(mainArtist("Anitta feat. Cardi B")).toBe("anitta");
    expect(mainArtist("Anitta, Cardi B")).toBe("anitta");
    expect(mainArtist("Anitta - Topic")).toBe("anitta");
    expect(mainArtist("The Beatles")).toBe("beatles");
    expect(titleKey("Downtown (feat. Cardi B)")).toBe(titleKey("Downtown"));
  });

  it("mantém partes do título que não são enfeite", () => {
    expect(titleKey("Faroeste Caboclo (Parte 2)")).not.toBe(titleKey("Faroeste Caboclo"));
    expect(titleKey("Song (Part 2)")).not.toBe(titleKey("Song"));
  });
});
