import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): { parts: string[]; query: URLSearchParams } {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  const [path, qs] = hash.replace(/^#\/?/, "").split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

export function navigate(path: string) {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}
