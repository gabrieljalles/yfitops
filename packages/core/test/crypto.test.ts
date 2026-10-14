import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  contentId,
  decryptFile,
  deriveUserKeys,
  eciesOpen,
  eciesSeal,
  encryptContent,
  encryptFile,
  fromB64,
  generateKeyPair,
  importPrivateKey,
  newMasterKey,
  openJSON,
  extractTarget,
  planImport,
  randomBytes,
  sealedSize,
  sealJSON,
  toB64,
} from "../src";
import { deriveFromPassword } from "../src/password";

describe("arquivos em blocos", () => {
  for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 12345]) {
    it(`ida e volta com ${size} bytes`, async () => {
      const data = randomBytes(Math.min(size, 65536));
      const big = new Uint8Array(size);
      for (let i = 0; i < size; i += data.length) big.set(data.subarray(0, Math.min(data.length, size - i)), i);
      const { fileKey, sealed } = await encryptFile(big);
      expect(sealed.length).toBe(sealedSize(size));
      expect(await decryptFile(fileKey, sealed)).toEqual(big);
    });
  }

  it("detecta truncamento no último bloco", async () => {
    const { fileKey, sealed } = await encryptFile(new Uint8Array(CHUNK_SIZE * 2 + 10));
    await expect(decryptFile(fileKey, sealed.subarray(0, sealedSize(CHUNK_SIZE * 2)))).rejects.toThrow();
  });

  it("detecta adulteração", async () => {
    const { fileKey, sealed } = await encryptFile(new Uint8Array(1000));
    sealed[10] ^= 1;
    await expect(decryptFile(fileKey, sealed)).rejects.toThrow();
  });
});

describe("chaves do usuário", () => {
  it("metadados ficam presos ao ID", async () => {
    const keys = await deriveUserKeys(newMasterKey());
    const enc = await sealJSON(keys.enc, "a", { title: "x" });
    expect(await openJSON(keys.enc, "a", enc)).toEqual({ title: "x" });
    await expect(openJSON(keys.enc, "b", enc)).rejects.toThrow();
  });

  it("ID de conteúdo é estável por usuário e diferente entre usuários", async () => {
    const mk = newMasterKey();
    const a = await deriveUserKeys(mk);
    const b = await deriveUserKeys(mk);
    const other = await deriveUserKeys(newMasterKey());
    const data = new Uint8Array([1, 2, 3]);
    expect(await contentId(a, data)).toBe(await contentId(b, data));
    expect(await contentId(a, data)).not.toBe(await contentId(other, data));
  });

  it("mesmo conteúdo gera o mesmo cifrado (reenvio não quebra chaves antigas)", async () => {
    const keys = await deriveUserKeys(newMasterKey());
    const data = randomBytes(300_000);
    const a = await encryptContent(keys, data);
    const b = await encryptContent(keys, data);
    expect(a.id).toBe(b.id);
    expect(a.fileKey).toEqual(b.fileKey);
    expect(a.sealed).toEqual(b.sealed);
    expect(await decryptFile(a.fileKey, b.sealed)).toEqual(data);
    const other = await encryptContent(await deriveUserKeys(newMasterKey()), data);
    expect(other.id).not.toBe(a.id);
    expect(other.fileKey.key).not.toBe(a.fileKey.key);
  });

  it("ECIES ida e volta", async () => {
    const kp = await generateKeyPair();
    const sealed = await eciesSeal(kp.publicKey, new Uint8Array([9, 8, 7]));
    expect(await eciesOpen(await importPrivateKey(kp.privateKey), sealed)).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("senha deriva as mesmas chaves para o mesmo e-mail", async () => {
    const a = await deriveFromPassword("Eu@Mail.com ", "senha");
    const b = await deriveFromPassword("eu@mail.com", "senha");
    const c = await deriveFromPassword("eu@mail.com", "outra");
    expect(a.authKey).toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
    expect(fromB64(a.authKey).length).toBe(32);
    expect(toB64(fromB64(a.authKey))).toBe(a.authKey);
  });
});

describe("decisão de compressão", () => {
  it("comuns e leves ficam como estão", () => {
    expect(planImport("a.mp3", { codec: "MPEG 1 Layer 3", lossless: false })).toBe("keep");
    expect(planImport("a.m4a", { codec: "MPEG-4/AAC", container: "M4A/isom" })).toBe("keep");
    expect(planImport("a.ogg", { codec: "Vorbis I", lossless: false })).toBe("keep");
    expect(planImport("a.opus", { codec: "Opus", lossless: false })).toBe("keep");
  });

  it("sem perda vira FLAC verificado", () => {
    expect(planImport("a.wav", { codec: "PCM", lossless: true })).toBe("lossless");
    expect(planImport("a.m4a", { codec: "ALAC", container: "M4A/isom" })).toBe("lossless");
    expect(planImport("a.ape", { codec: "Monkey's Audio" })).toBe("lossless");
    expect(planImport("a.wv", {})).toBe("lossless");
  });

  it("DSD, vídeo e com perda incomum", () => {
    expect(planImport("a.dsf", { codec: "DSD", container: "DSF" })).toBe("dsd");
    expect(planImport("a.dff", {})).toBe("dsd");
    expect(planImport("clipe.mp4", { codec: "MPEG-4/AAC" })).toBe("extract");
    expect(planImport("show.mkv", {})).toBe("extract");
    expect(planImport("a.wma", { codec: "Windows Media Audio 9", lossless: false })).toBe("keep+light");
    expect(planImport("a.ac3", { codec: "AC-3", lossless: false })).toBe("keep+light");
    expect(planImport("a.mp2", { codec: "MPEG 1 Layer 2", lossless: false })).toBe("keep+light");
    expect(planImport("a.xyz", {})).toBe("keep+light");
  });

  it("extração escolhe contêiner sem reconverter", () => {
    expect(extractTarget("MPEG-4/AAC").ext).toBe("m4a");
    expect(extractTarget("Opus").ext).toBe("opus");
    expect(extractTarget("AC-3").ext).toBe("mka");
  });
});
