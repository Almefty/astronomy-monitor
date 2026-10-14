import type { ApodData, ApodEntry } from "../../shared/contract";
import { fetchSource } from "../core/api";
import { h, icon, safeUrl } from "../core/dom";
import { utcDate } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";

const dateLabel = (d: string) => utcDate(`${d}T12:00:00Z`, true);

function embedUrl(url: string): string | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  const u = new URL(safe);
  if (/^(www\.|m\.)?youtube\.com$/.test(u.hostname)) u.hostname = "www.youtube-nocookie.com";
  if (!/^(www\.youtube-nocookie\.com|player\.vimeo\.com)$/.test(u.hostname)) return null;
  u.protocol = "https:";
  return u.toString();
}

function media(e: ApodEntry): HTMLElement {
  const box = h("div", { class: "apod-media" });
  const fallback = (msg: string) => box.replaceChildren(h("div", { class: "no-media" }, msg));
  if (e.mediaType === "video" && e.videoUrl) {
    if (e.videoKind === "file" && safeUrl(e.videoUrl)) {
      const v = h("video", { controls: true, preload: "metadata", playsinline: true, poster: safeUrl(e.imageUrl) ?? undefined, "aria-label": e.title });
      v.append(h("source", { src: safeUrl(e.videoUrl)! }));
      box.append(v);
      return box;
    }
    const src = embedUrl(e.videoUrl);
    if (src) {
      // Sandboxed: the players need scripts and their own origin (cookies-free YouTube, Vimeo) and may
      // open "Watch on YouTube/Vimeo" in a new tab, but can't navigate this page or open dialogs.
      const sandbox = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
      box.append(h("iframe", { sandbox, src, title: e.title, loading: "lazy", allow: "fullscreen; picture-in-picture; encrypted-media", referrerpolicy: "strict-origin-when-cross-origin" }));
      return box;
    }
  }
  const src = safeUrl(e.imageUrl);
  if (!src) {
    fallback("This entry has no preview image — open it on NASA’s site.");
    return box;
  }
  const img = h("img", { src, alt: e.alt || e.title, decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => fallback("The image could not be loaded."));
  box.append(img);
  return box;
}

function entryView(e: ApodEntry): HTMLElement {
  const text = h("p", { class: "apod-text" }, e.explanation);
  const more = h("button", { class: "btn btn-quiet apod-more", type: "button", "aria-expanded": "false" }, "Read more");
  more.addEventListener("click", () => {
    const open = text.classList.toggle("is-open");
    more.textContent = open ? "Show less" : "Read more";
    more.setAttribute("aria-expanded", String(open));
  });
  const hd = safeUrl(e.hdUrl);
  const page = safeUrl(e.permalink);
  return h(
    "div",
    null,
    media(e),
    h("h3", { class: "apod-title" }, e.title),
    h(
      "div",
      { class: "apod-meta" },
      h("span", { class: "mono" }, dateLabel(e.date)),
      // Always shown: most APOD images are copyrighted by their authors, not NASA.
      h("span", null, e.credit ? `Image credit & copyright: ${e.credit}` : "Image credit & copyright: see the entry on NASA’s site"),
    ),
    text,
    h(
      "div",
      { class: "apod-links" },
      more,
      hd ? h("a", { class: "btn apod-ext", href: hd, target: "_blank", rel: "noopener" }, "Full resolution", icon(ICONS.external)) : null,
      page ? h("a", { class: "btn apod-ext", href: page, target: "_blank", rel: "noopener" }, "View on NASA", icon(ICONS.external)) : null,
    ),
  );
}

export const apodPanel: PanelDefinition<ApodData> = {
  id: "apod",
  title: "Astronomy Picture of the Day",
  subtitle: "Today’s featured image and the past week, explained by professional astronomers",
  icon: ICONS.image,
  span: "span-5",
  source: { name: "NASA APOD (science.nasa.gov)", url: "https://science.nasa.gov/apod/" },

  async load(signal): Promise<PanelResult<ApodData>> {
    const env = await fetchSource("apod", {}, signal);
    return { data: env.data, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
  },

  render(root, { data }) {
    const holder = h("div");
    const strip = h("div", { class: "filmstrip", role: "group", "aria-label": "Recent days" });
    const select = (e: ApodEntry) => {
      holder.replaceChildren(entryView(e));
      for (const b of strip.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.date === e.date));
    };
    for (const e of data.recent) {
      const thumb = safeUrl(e.thumbUrl);
      const b = h(
        "button",
        { type: "button", "data-date": e.date, title: `${dateLabel(e.date)} — ${e.title}`, "aria-label": `${dateLabel(e.date)}: ${e.title}` },
        thumb ? h("img", { src: thumb, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }) : null,
        e.mediaType === "video" ? icon(ICONS.play) : null,
        h("span", { class: "day" }, utcDate(`${e.date}T12:00:00Z`)),
      );
      b.querySelector("svg")?.classList.add("vid");
      b.addEventListener("click", () => select(e));
      strip.append(b);
    }
    root.append(holder);
    if (data.recent.length > 1) root.append(strip);
    root.append(
      h(
        "p",
        { class: "apod-rights" },
        "Pictures, videos and explanations are shown as published by NASA’s Astronomy Picture of the Day. Each image belongs to the credited author and may be copyrighted; it is not covered by this project’s license. ",
        h("a", { href: "https://science.nasa.gov/apod/about-apod/", target: "_blank", rel: "noopener" }, "About APOD"),
      ),
    );
    select(data.today);
  },

  summarize({ data }) {
    return {
      label: "Picture of the day",
      icon: ICONS.image,
      value: data.today.title,
      detail: `${dateLabel(data.today.date)}${data.today.credit ? ` · ${data.today.credit}` : ""}`,
    };
  },
};
