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
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  dbp ??= openDB<Schema>("yfitops", 1, {
    upgrade(d) {
      d.createObjectStore("kv");
      d.createObjectStore("items", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "id" });
      d.createObjectStore("files", { keyPath: "key" });
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
  await Promise.all((["kv", "items", "outbox", "files"] as const).map((s) => d.clear(s)));
}
