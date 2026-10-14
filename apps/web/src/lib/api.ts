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
  async bytes(path: string, init: Init = {}): Promise<Uint8Array> {
    return new Uint8Array(await (await raw(path, init)).arrayBuffer());
  },
};
