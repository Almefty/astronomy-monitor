import type { ApodData, ApodEntry } from "../../shared/contract";
import { nasaKey } from "../lib/env";
import type { Upstream } from "../lib/upstream";
import { SourceError } from "../lib/upstream";
import { addDays, htmlToText, isoDate } from "../lib/util";
import type { SourceModule } from "./types";

/**
 * APOD moved to science.nasa.gov in 2026. Its official JSON endpoint is the
 * WordPress "apod-basic" route (no key). The legacy api.nasa.gov/planetary/apod
 * still answers but currently returns placeholder records (title "NASA Science",
 * the NASA logo as image) and is scheduled to go offline on 2026-12-01, so it is
 * only used as a validated fallback.
 */
const APOD_BASIC = "https://science.nasa.gov/wp-json/wp/v2/apod-basic";
const APOD_LEGACY = "https://api.nasa.gov/planetary/apod";
const RECENT_DAYS = 10;

/** Generic NASA artwork the new site uses as "hdurl" for videos without a poster frame. */
const PLACEHOLDER_IMAGE = /(news-thumbnail|NASA-Meatball|nasa-logo)[^/]*\.(png|jpe?g|svg|webp)/i;

const yymmdd = (d: Date) => isoDate(d).slice(2).replace(/-/g, "");

/** Re-size images served by NASA's dynamic image service; leave other hosts untouched. */
export function sizedImage(url: string | null, size: "display" | "thumb"): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    if (u.hostname === "assets.science.nasa.gov" && u.pathname.startsWith("/dynamicimage/")) {
      u.search = size === "display" ? "?w=1600&fit=clip" : "?w=480&h=320&fit=crop";
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function cleanExplanation(html: string): string {
  return htmlToText(html)
    .replace(/^\s*Explanation:\s*/i, "")
    .replace(/\s*Tomorrow['’]s picture:[\s\S]*$/i, "")
    .trim();
}

function youtubeId(src: string): string | null {
  return /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src)?.[1] ?? null;
}

interface RawBasic {
  date: string; title: string; permalink: string; media_type: string; explanation: string;
  credit?: string; copyright?: string; alt?: string; url?: string; hdurl?: string | null; basic_html?: string;
}

export function fromBasic(x: RawBasic): ApodEntry {
  const html = x.basic_html ?? "";
  const iframe = /<iframe[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? null;
  const source = /<source[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? /<video[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? null;
  const rawHd = x.hdurl && !PLACEHOLDER_IMAGE.test(x.hdurl) ? x.hdurl : null;
  const isVideo = x.media_type === "video";

  let videoUrl: string | null = null;
  let videoKind: ApodEntry["videoKind"] = null;
  let poster = rawHd;
  if (isVideo && iframe) {
    videoUrl = iframe.startsWith("//") ? `https:${iframe}` : iframe;
    videoKind = "embed";
    const yt = youtubeId(videoUrl);
    if (yt && !poster) poster = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  } else if (isVideo && source) {
    videoUrl = source.startsWith("//") ? `https:${source}` : source;
    videoKind = "file";
  }

  return {
    date: x.date,
    title: htmlToText(x.title),
    mediaType: isVideo ? "video" : x.media_type === "image" ? "image" : "other",
    imageUrl: sizedImage(poster, "display"),
    // The new site's hdurl already carries the original pixel size (?w=…&h=…&fit=clip).
    hdUrl: isVideo ? null : rawHd,
    thumbUrl: sizedImage(poster, "thumb"),
    videoUrl,
    videoKind,
    explanation: cleanExplanation(x.explanation ?? ""),
    credit: htmlToText(x.credit || x.copyright || ""),
    alt: htmlToText(x.alt ?? ""),
    permalink: x.permalink || x.url || "https://science.nasa.gov/apod/",
  };
}

interface RawLegacy {
  date: string; title: string; explanation: string; media_type: string; url?: string; hdurl?: string;
  thumbnail_url?: string; copyright?: string;
}

/** The legacy API's broken records point at the NASA logo with the page title "NASA Science". */
export function isPlaceholderLegacy(x: RawLegacy): boolean {
  return x.title?.trim() === "NASA Science" || PLACEHOLDER_IMAGE.test(x.url ?? "") || PLACEHOLDER_IMAGE.test(x.hdurl ?? "");
}

function fromLegacy(x: RawLegacy): ApodEntry {
  const isVideo = x.media_type === "video";
  const image = isVideo ? x.thumbnail_url ?? null : x.url ?? null;
  return {
    date: x.date,
    title: x.title,
    mediaType: isVideo ? "video" : x.media_type === "image" ? "image" : "other",
    imageUrl: image,
    hdUrl: isVideo ? null : x.hdurl ?? x.url ?? null,
    thumbUrl: image,
    videoUrl: isVideo ? x.url ?? null : null,
    videoKind: isVideo ? (/youtube|vimeo/.test(x.url ?? "") ? "embed" : "file") : null,
    explanation: cleanExplanation(x.explanation ?? ""),
    credit: (x.copyright ?? "").replace(/\s+/g, " ").trim(),
    alt: "",
    permalink: `https://apod.nasa.gov/apod/ap${x.date.slice(2).replace(/-/g, "")}.html`,
  };
}

async function loadBasic(upstream: Upstream, now: Date): Promise<ApodEntry[]> {
  // Ranged query: tolerant of "today" not being published yet in your time zone.
  const q = new URLSearchParams({ date_from: yymmdd(addDays(now, -RECENT_DAYS)), date_to: yymmdd(addDays(now, 1)), per_page: "25" });
  const rows = await upstream.json<RawBasic[]>("APOD (science.nasa.gov)", `${APOD_BASIC}?${q}`);
  if (!Array.isArray(rows) || rows.length === 0) throw new SourceError("parse", "science.nasa.gov returned no APOD entries.");
  return rows.map(fromBasic).sort((a, b) => b.date.localeCompare(a.date));
}

async function loadLegacy(upstream: Upstream, key: string, now: Date): Promise<ApodEntry[]> {
  const q = new URLSearchParams({ api_key: key, start_date: isoDate(addDays(now, -RECENT_DAYS)), thumbs: "true" });
  const rows = await upstream.json<RawLegacy[]>("APOD (api.nasa.gov, legacy)", `${APOD_LEGACY}?${q}`, { timeoutMs: 20_000 });
  const good = (Array.isArray(rows) ? rows : []).filter((r) => !isPlaceholderLegacy(r));
  if (!good.length) {
    throw new SourceError("upstream", "api.nasa.gov APOD returned only placeholder records (\"NASA Science\" / NASA logo).");
  }
  return good.map(fromLegacy).sort((a, b) => b.date.localeCompare(a.date));
}

export const apodSource: SourceModule<"apod"> = {
  id: "apod",
  title: "Astronomy Picture of the Day",
  provider: "NASA APOD · science.nasa.gov (api.nasa.gov fallback)",
  docsUrl: "https://science.nasa.gov/apod/",

  async load({ upstream, env, now, notices }) {
    let entries: ApodEntry[];
    let via: ApodData["via"] = "science.nasa.gov";
    try {
      entries = await loadBasic(upstream, now);
    } catch (primaryErr) {
      const { key, mode } = nasaKey(env);
      try {
        entries = await loadLegacy(upstream, key, now);
        via = "api.nasa.gov";
        notices.push({
          level: "warning",
          text: `science.nasa.gov was unavailable (${(primaryErr as Error).message}); showing the legacy api.nasa.gov feed${mode === "demo" ? " via DEMO_KEY" : ""}.`,
        });
      } catch (fallbackErr) {
        throw new SourceError(
          "upstream",
          `APOD unavailable. science.nasa.gov: ${(primaryErr as Error).message} · api.nasa.gov: ${(fallbackErr as Error).message}`,
        );
      }
    }
    const data: ApodData = { via, today: entries[0]!, recent: entries.slice(0, 8) };
    return data;
  },
};
