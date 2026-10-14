import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ItemKind, SyncPushItem } from "@yfitops/core";

export interface LocalItem {
  id: string;
  kind: ItemKind;
  value: unknown;
}

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  items: { key: string; value: LocalItem };
  /** Alterações locais ainda não enviadas ao servidor. */
  outbox: { key: string; value: SyncPushItem };
  /** Arquivos baixados para offline — guardados ainda criptografados. */
  files: { key: string; value: { key: string; data: Blob; size: number; at: number } };
  /**
   * Músicas já ouvidas (cache automático, com limite de espaço): tocar de novo
   * não pede nada ao servidor. `at` = última vez que tocou (sai a mais antiga).
   */
  cache: { key: string; value: { key: string; data: Blob; size: number; at: number } };
  /** Tamanho e último uso de cada música do cache, sem abrir os arquivos (limpeza rápida). */
  cacheMeta: { key: string; value: { key: string; size: number; at: number } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  dbp ??= openDB<Schema>("yfitops", 3, {
    upgrade(d, from, _to, tx) {
      if (from < 1) {
        d.createObjectStore("kv");
        d.createObjectStore("items", { keyPath: "id" });
        d.createObjectStore("outbox", { keyPath: "id" });
        d.createObjectStore("files", { keyPath: "key" });
      }
      if (from < 2) d.createObjectStore("cache", { keyPath: "key" });
      if (from < 3) {
        d.createObjectStore("cacheMeta", { keyPath: "key" });
        // O cache da versão anterior não tinha a lista de tamanhos: recomeça vazio.
        if (from === 2) void tx.objectStore("cache").clear();
      }
    },
  });
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown) {
  await (await db()).put("kv", value, key);
}

/** Apaga tudo deste aparelho (logout). */
export async function wipe() {
  const d = await db();
  await Promise.all((["kv", "items", "outbox", "files", "cache", "cacheMeta"] as const).map((s) => d.clear(s)));
}
