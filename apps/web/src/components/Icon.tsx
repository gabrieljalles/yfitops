const paths = {
  play: "M8 5.5v13l11-6.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  next: "M6 6l8.5 6L6 18zM16 6h2v12h-2z",
  prev: "M18 6l-8.5 6L18 18zM6 6h2v12H6z",
  shuffle: "M4 7h3.5c2 0 3 1 4.2 2.8l1.6 2.4C14.5 14 15.5 17 17.5 17H20M17.5 14.5L20 17l-2.5 2.5M4 17h3.5c1 0 1.7-.4 2.3-1M20 7h-2.5c-1 0-1.7.4-2.3 1M17.5 4.5L20 7l-2.5 2.5",
  repeat: "M5 11V9a2 2 0 0 1 2-2h11M15.5 4.5L18 7l-2.5 2.5M19 13v2a2 2 0 0 1-2 2H6M8.5 19.5L6 17l2.5-2.5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  home: "M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20",
  library: "M5 4v16M9.5 4v16M14 4.5l5 15",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  share: "M8.5 10.5l7-4M8.5 13.5l7 4M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13",
  down: "M6 9l6 6 6-6",
  queue: "M4 6h12M4 12h12M4 18h7M17 15v6l4-3z",
  cloud: "M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z",
  youtube: "M3 8.5A3.5 3.5 0 0 1 6.5 5h11A3.5 3.5 0 0 1 21 8.5v7a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 15.5zM10 9.3v5.4l4.6-2.7z",
  spotify: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM7.3 9.4c3.1-1 6.7-.7 9.4.9M7.9 12.5c2.6-.7 5.4-.4 7.6.8M8.5 15.4c2-.5 4-.3 5.7.6",
  // Barras de equalizador, como no logo do Deezer.
  deezer: "M4 19v-2M8 19v-5M12 19v-8M16 19v-11M20 19v-14",
  heart: "M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z",
  heartFilled: "M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z",
  sync: "M19 8a7.5 7.5 0 0 0-13.4-1.6M5 4v3h3M5 16a7.5 7.5 0 0 0 13.4 1.6M19 20v-3h-3",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0",
} as const;

export type IconName = keyof typeof paths;

const filled = new Set<IconName>(["play", "pause", "next", "prev", "heartFilled"]);

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const fill = filled.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={name === "more" ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
