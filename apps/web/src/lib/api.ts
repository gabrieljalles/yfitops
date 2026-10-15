let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Init = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit };

async function raw(path: string, init: Init = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  if (!res.ok) {
    let message = `Erro ${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* corpo não-JSON */
    }
    if (res.status === 401 && token && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, message);
  }
  return res;
}

export const api = {
  raw,
  async json<T>(path: string, init: Init = {}): Promise<T> {
    return (await raw(path, init)).json() as Promise<T>;
  },
  /** Com `onProgress`, avisa quanto já chegou (0 a 1) enquanto baixa. */
  async bytes(path: string, init: Init = {}, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
    const res = await raw(path, init);
    const total = Number(res.headers.get("Content-Length")) || 0;
    if (!onProgress || !total || !res.body) return new Uint8Array(await res.arrayBuffer());
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // O servidor mandou mais do que disse: devolve o que veio, sem cortar.
      if (got + value.length > total) return concat(out.subarray(0, got), value, reader);
      out.set(value, got);
      got += value.length;
      onProgress(got / total);
    }
    return got === total ? out : out.slice(0, got);
  },
};

/** Junta o que já veio com o resto da resposta (quando o Content-Length mentiu). */
async function concat(head: Uint8Array, next: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const parts = [head, next];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}
