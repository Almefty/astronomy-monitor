// Small, hand-drawn line icons (24×24, currentColor). Static markup only.
const wrap = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  refresh: wrap(`<path class="spin-path" d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>`),
  sun: wrap(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: wrap(`<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>`),
  auto: wrap(`<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>`),
  asteroid: wrap(`<path d="M8.5 5.5l5-1.5 4.5 3 1.5 5-2 5-5 2.5-5-1-3-4 .5-5z"/><circle cx="10" cy="10" r="1.2"/><circle cx="14.5" cy="14" r="1.6"/>`),
  flare: wrap(`<circle cx="9" cy="15" r="5"/><path d="M12.5 11.5c2-4 5-6 8.5-6.5-1 3-3 6-7 8"/>`),
  planet: wrap(`<circle cx="12" cy="12" r="5.5"/><path d="M3.5 15.5c-1.3 2 .2 3 3.5 2.4 3-.6 7-2.3 10.2-4.4 3.2-2.1 4.6-4 3.3-5.1-.8-.7-2.4-.6-4.3 0"/>`),
  image: wrap(`<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/>`),
  telescope: wrap(`<path d="M3 13l12-6 2 4-12 6z"/><path d="M15 7l3.5-1.7 2 4L17 11"/><path d="M9 15l-3 6M10.5 14.5l2.5 6.5"/>`),
  external: wrap(`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`),
  orbit: wrap(`<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9.5" ry="5" transform="rotate(-25 12 12)"/><circle cx="19.6" cy="8.3" r="1.5" fill="currentColor" stroke="none"/>`),
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>`,
  reverse: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 4.5v15L4 12z"/></svg>`,
  now: wrap(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>`,
  burst: wrap(`<circle cx="12" cy="12" r="2.6"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.8 2.8M15.9 15.9l2.8 2.8M5.3 18.7l2.8-2.8M15.9 8.1l2.8-2.8"/>`),
  close: wrap(`<path d="M6 6l12 12M18 6L6 18"/>`),
  prev: wrap(`<path d="M15 5l-7 7 7 7"/>`),
  next: wrap(`<path d="M9 5l7 7-7 7"/>`),
  first: wrap(`<path d="M17 5l-7 7 7 7M6.5 5v14"/>`),
  last: wrap(`<path d="M7 5l7 7-7 7M17.5 5v14"/>`),
  list: wrap(`<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>`),
  doc: wrap(`<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/>`),
  layers: wrap(`<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>`),
  recenter: wrap(`<circle cx="12" cy="12" r="3"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>`),
  key: wrap(`<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>`),
} as const;
