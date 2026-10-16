import { addDaysIso, APOD_FIRST, apodToday, isIsoDate, weekStartOf } from "../../shared/apod";
import type { ApodData, ApodEntry, ApodWeekData } from "../../shared/contract";
import { nasaKey } from "../lib/env";
import type { Param } from "../lib/params";
import type { Upstream } from "../lib/upstream";
import { SourceError } from "../lib/upstream";
import { addDays, decodeEntities, htmlToText, isoDate } from "../lib/util";
import type { SourceModule } from "./types";

/**
 * APOD moved to science.nasa.gov in 2026. Its official JSON endpoint is the
 * WordPress "apod-basic" route (no key). The legacy api.nasa.gov/planetary/apod
 * still answers but currently returns placeholder records (title "NASA Science",
 * the NASA logo as image) and is scheduled to go offline on 2026-12-01, so it is
 * only used as a validated fallback.
 */
const APOD_BASIC = "https://science.nasa.gov/wp-json/wp/v2/apod-basic";
/** Official APOD RSS feed (last 30 days). Same fields as apod-basic; used when the JSON API is unavailable. */
const APOD_FEED = "https://science.nasa.gov/feed/apod-basic/";
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
    // Archive images live under /content/dam/, which ignores size parameters; the same JPEG/PNG under
    // /dynamicimage/assets/ is resized (a 2,500 px, 500 KB picture → 19 KB thumbnail). GIFs aren't served there.
    if (u.hostname === "assets.science.nasa.gov" && /^\/content\/dam\/.+\.(?:jpe?g|png)$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/^\/content\/dam\//, "/dynamicimage/assets/");
    }
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
    .replace(/digg_url\s*=\s*'[^']*';\s*digg_skin\s*=\s*'[^']*';/g, "") // leftovers of 2009-era share buttons
    .replace(/^\s*Explanation:\s*/i, "")
    .replace(/\s*Tomorrow['’]s picture:[\s\S]*$/i, "")
    .trim();
}

function youtubeId(src: string): string | null {
  return /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src)?.[1] ?? null;
}

/** Players the panel may embed (the CSP's frame-src); every other iframe is linked instead. */
const EMBED_HOST = /^(?:(?:www\.|m\.)?youtube(?:-nocookie)?\.com|player\.vimeo\.com)$/i;
/** Video files browsers play natively. Older APOD movies (MPEG, QuickTime, AVI, Flash) are linked instead. */
const PLAYABLE_FILE = /\.(?:mp4|m4v|webm|ogv)(?:[?#]|$)/i;
const VIDEO_FILE = /\.(?:mp4|m4v|webm|ogv|mpe?g|mov|qt|avi|wmv|flv|swf|asf|rm)(?:[?#]|$)/i;
const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|tiff?)(?:[?#]|$)/i;

/** Absolute https URL where NASA serves one; relative links resolve against the classic APOD site. */
export function absUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), "https://apod.nasa.gov/apod/");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (/(^|\.)nasa\.gov$/i.test(u.hostname)) u.protocol = "https:"; // NASA hosts all serve https (the CSP needs it)
    return u.toString();
  } catch {
    return null;
  }
}

/** The classic APOD page body inside basic_html (its <head> repeats the placeholder og:image). */
function pageBody(html: string): string {
  const i = html.search(/<body[\s>]/i);
  return i >= 0 ? html.slice(i) : html;
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined) ?? null;

/**
 * Plain-text credit line. Some entries repeat the label inside the field ("<strong>Image Credit:</strong> NASA, …");
 * the panel adds its own label, so drop it here.
 */
export function creditText(raw: string | undefined): string {
  return htmlToText(raw ?? "")
    // 1997-era entries put the title on a line of its own before the label ("Hubble Floats Free <br /> Credit:")
    .replace(/^[^\n]*\n\s*(?=(?:(?:image|video|illustration)\s+)?credits?\b[^\n:]{0,20}:)/i, "")
    .replace(/\s+/g, " ")
    // "Image Credit & Copyright:", "Credit:", and (2008-era) "Credit & Copyright" without a colon
    .replace(/^(?:(?:image|video|illustration)\s+)?credits?(?:\s*(?:&|and)\s*copyright\s*:?|\s*:)\s*/i, "")
    .trim();
}

interface RawBasic {
  date: string; title: string; permalink: string; media_type: string | null; explanation: string;
  credit?: string; copyright?: string; alt?: string; url?: string; hdurl?: string | null; basic_html?: string;
}

export function fromBasic(x: RawBasic): ApodEntry {
  const body = pageBody(x.basic_html ?? "");
  const iframe = absUrl(attr(/<iframe\b[^>]*>/i.exec(body)?.[0] ?? "", "src"));
  const source = absUrl(attr(/<(?:source|video)\b[^>]*\bsrc\b[^>]*>/i.exec(body)?.[0] ?? "", "src"));
  // Before ~2015 the API's hdurl is a placeholder; the picture is the first <img> of the page body,
  // usually wrapped in a link to the full-size file (or, for old movies, to an MPEG/QuickTime file).
  const pic = /(?:<a\b([^>]*)>\s*)?<img\b([^>]*)>/i.exec(body);
  const picSrc = pic ? absUrl(attr(pic[2]!, "src")) : null;
  const picLink = pic?.[1] ? absUrl(attr(pic[1], "href")) : null;
  const rawHd = x.hdurl && !PLACEHOLDER_IMAGE.test(x.hdurl) ? x.hdurl : null;
  const linkedVideo = picLink && VIDEO_FILE.test(picLink) ? picLink : null;
  const isVideo = x.media_type === "video" || x.media_type === "iframe" || !!iframe || !!source || !!linkedVideo;

  let videoUrl: string | null = null;
  let videoKind: ApodEntry["videoKind"] = null;
  let poster = rawHd ?? picSrc;
  if (isVideo && iframe) {
    videoUrl = iframe;
    videoKind = EMBED_HOST.test(new URL(iframe).hostname) ? "embed" : "external";
    const yt = youtubeId(videoUrl);
    if (yt && !poster) poster = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  } else if (isVideo && (source || linkedVideo)) {
    videoUrl = (source ?? linkedVideo)!;
    videoKind = PLAYABLE_FILE.test(videoUrl) ? "file" : "external";
  } else if (isVideo) {
    videoKind = "external"; // labelled a video, but nothing on the page we can play or link
  }

  const fullSize = rawHd ?? (picLink && IMAGE_FILE.test(picLink) ? picLink : picSrc);
  return {
    date: x.date,
    // A few broken entries carry the page title ("APOD: 2011 May 26 – Supernova Sonata").
    title: htmlToText(x.title).replace(/^APOD:\s*\d{4}\s+\w+\s+\d{1,2}\s*[–—-]\s*/, ""),
    mediaType: isVideo ? "video" : x.media_type === "image" || poster ? "image" : "other",
    imageUrl: sizedImage(poster, "display"),
    // The new site's hdurl already carries the original pixel size (?w=…&h=…&fit=clip).
    hdUrl: isVideo ? null : fullSize,
    thumbUrl: sizedImage(poster, "thumb"),
    videoUrl,
    videoKind,
    explanation: cleanExplanation(x.explanation ?? ""),
    credit: creditText(x.credit || x.copyright),
    alt: htmlToText(x.alt ?? "").replace(/^See Explanation\.\s*Clicking on the picture will download the highest resolution version available\.$/i, ""),
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
    credit: creditText(x.copyright),
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

/** Text of the first <tag>…</tag> in an XML fragment, CDATA unwrapped and entities decoded. */
function xmlField(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]!);
  return cdata ? cdata[1]! : decodeEntities(m[1]!.trim());
}

/** APOD date of a feed item: the discussion link carries it (date=YYMMDD); fall back to the slug, then pubDate. */
export function feedItemDate(item: string): string | null {
  const disc = /date=(\d{2})(\d{2})(\d{2})/.exec(xmlField(item, "apod:discussion"));
  if (disc) return `20${disc[1]}-${disc[2]}-${disc[3]}`;
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const slug = /apod-(\d{4})-([a-z]+)-(\d{1,2})-/.exec(xmlField(item, "link"));
  if (slug && MONTHS.includes(slug[2]!)) {
    return `${slug[1]}-${String(MONTHS.indexOf(slug[2]!) + 1).padStart(2, "0")}-${slug[3]!.padStart(2, "0")}`;
  }
  const pub = new Date(xmlField(item, "pubDate"));
  return Number.isNaN(pub.getTime()) ? null : isoDate(pub);
}

/** Parse the APOD RSS feed into the same raw shape as apod-basic, so fromBasic() handles both. */
export function parseFeed(xml: string, max = Infinity): RawBasic[] {
  const out: RawBasic[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= max) break; // newest first; stop early to stay well within the Worker CPU budget
    const date = feedItemDate(item!);
    if (!date) continue;
    const body = xmlField(item!, "content:encoded") || xmlField(item!, "description");
    out.push({
      date,
      title: xmlField(item!, "title"),
      permalink: xmlField(item!, "link"),
      media_type: /<(video|iframe)\b/i.test(body) ? "video" : "image",
      explanation: xmlField(item!, "apod:explanation"),
      credit: xmlField(item!, "apod:credit"),
      copyright: xmlField(item!, "apod:copyright"),
      alt: xmlField(item!, "apod:alt"),
      hdurl: xmlField(item!, "apod:hdurl") || null,
      basic_html: body,
    });
  }
  return out;
}

async function loadFeed(upstream: Upstream): Promise<ApodEntry[]> {
  const xml = await upstream.text("APOD (science.nasa.gov RSS feed)", APOD_FEED, {
    headers: { accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
  });
  const rows = parseFeed(xml, RECENT_DAYS);
  if (rows.length === 0) throw new SourceError("parse", "The APOD RSS feed contained no entries.");
  return rows.map(fromBasic).sort((a, b) => b.date.localeCompare(a.date));
}

export { apodToday };

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Short, accurate reason for a failed upstream call, for the panel note. */
export function describeFailure(err: Error): string {
  const m = err.message;
  const status = /HTTP (\d{3})/.exec(m)?.[1];
  if (status) return `answered HTTP ${status}${/Checking your browser|Javascript required/i.test(m) ? " (a JavaScript browser check)" : ""}`;
  if (err instanceof SourceError && err.kind === "timeout") return "timed out";
  if (err instanceof SourceError && err.kind === "unreachable") return "could not be reached";
  if (err instanceof SourceError && err.kind === "parse") return "returned unusable data";
  return "failed";
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
  maxAge: 1800, // one new picture a day; at most 30 min late after it appears

  async load({ upstream, env, now, notices }) {
    // 1) JSON API  2) official RSS feed (same data)  3) legacy api.nasa.gov, accepted only if it
    // isn't placeholder data. The feed is also consulted when the JSON API lags behind today's APOD.
    let entries: ApodEntry[] | null = null;
    let via: ApodData["via"] = "science.nasa.gov";
    let jsonErr: Error | null = null;
    try {
      entries = await loadBasic(upstream, now);
    } catch (err) {
      jsonErr = err as Error;
    }

    const today = apodToday(now);
    if (entries && entries[0]!.date < today) {
      // JSON API works but hasn't published today's entry: use the feed if it is newer.
      try {
        const feed = await loadFeed(upstream);
        if (feed[0]!.date > entries[0]!.date) {
          notices.push({
            level: "info",
            text: `From NASA's APOD RSS feed: the science.nasa.gov JSON API's newest entry is still ${shortDate(entries[0]!.date)}, the feed already has ${shortDate(feed[0]!.date)}.`,
          });
          entries = feed;
        }
      } catch {
        /* keep the JSON entries; today's APOD may simply not be published yet */
      }
    }

    if (!entries) {
      let feedErr: Error;
      try {
        entries = await loadFeed(upstream);
        notices.push({ level: "info", text: `From NASA's APOD RSS feed: the science.nasa.gov JSON API ${describeFailure(jsonErr!)}.` });
      } catch (err) {
        feedErr = err as Error;
        const { key, mode } = nasaKey(env);
        try {
          entries = await loadLegacy(upstream, key, now);
          via = "api.nasa.gov";
          notices.push({
            level: "warning",
            text: `science.nasa.gov JSON API ${describeFailure(jsonErr!)} and the RSS feed ${describeFailure(feedErr)}; showing the legacy api.nasa.gov feed${mode === "demo" ? " via DEMO_KEY" : ""}.`,
          });
        } catch (legacyErr) {
          throw new SourceError(
            "upstream",
            `APOD unavailable. science.nasa.gov JSON: ${jsonErr!.message} · RSS feed: ${feedErr.message} · api.nasa.gov: ${(legacyErr as Error).message}`,
          );
        }
      }
    }
    const data: ApodData = { via, today: entries![0]!, recent: entries!.slice(0, 8) };
    return data;
  },
};

/* ------------------------------------------------------------------ */
/* Archive: one week per request                                       */
/* ------------------------------------------------------------------ */

/** Past weeks never change, so they are cached for 30 days; the current week only as long as today's APOD. */
export const ARCHIVE_MAX_AGE = 30 * 86_400;

const yymmddIso = (iso: string) => iso.slice(2).replace(/-/g, "");

/**
 * Any date → the Monday of its week, clamped to the archive (16 Jun 1995 … today); anything else → the
 * current week. Requests for the same week share one cache entry, so "Random day" and the date picker
 * reuse each other's answers, and at most ~1,700 distinct entries exist.
 */
export const weekParam: Param<string> = (raw) => {
  const today = apodToday(new Date());
  const iso = isIsoDate(raw) ? raw : today;
  return weekStartOf(iso < APOD_FIRST ? APOD_FIRST : iso > today ? today : iso);
};

/** Nearest published days around an empty week (one small query each; dates only). */
async function neighbours(upstream: Upstream, weekStart: string, weekEnd: string, today: string): Promise<[string | null, string | null]> {
  const dateOf = (rows: { date: string }[] | null, pick: "first" | "last") => {
    const d = Array.isArray(rows) && rows.length ? rows[pick === "first" ? 0 : rows.length - 1]!.date : null;
    return isIsoDate(d) ? d : null;
  };
  const beforeEnd = addDaysIso(weekStart, -1);
  const afterStart = addDaysIso(weekEnd, 1);
  const [before, after] = await Promise.all([
    beforeEnd < APOD_FIRST
      ? null
      : upstream
          .json<{ date: string }[]>("APOD archive (day before)", `${APOD_BASIC}?${new URLSearchParams({ date_to: yymmddIso(beforeEnd), per_page: "1", _fields: "date" })}`)
          .then((r) => dateOf(r, "first")), // newest first
    afterStart > today
      ? null
      : upstream
          .json<{ date: string }[]>(
              "APOD archive (day after)",
              `${APOD_BASIC}?${new URLSearchParams({ date_from: yymmddIso(afterStart), date_to: yymmddIso(addDaysIso(afterStart, 24)), per_page: "25", _fields: "date" })}`,
            )
          .then((r) => dateOf(r, "last")),
  ]);
  return [before, after];
}

export const apodArchiveSource: SourceModule<"apod-archive"> = {
  id: "apod-archive",
  title: "Astronomy Picture of the Day — archive",
  provider: "NASA APOD · science.nasa.gov",
  docsUrl: "https://science.nasa.gov/apod/archive/",
  maxAge: ARCHIVE_MAX_AGE,
  browserMaxAge: 86_400,
  params: { week: weekParam },

  async load({ upstream, params, now, cacheFor }) {
    const weekStart = weekParam(params.get("week"));
    const weekEnd = addDaysIso(weekStart, 6);
    const today = apodToday(now);
    // The week that holds today (or ended yesterday) can still gain an entry.
    if (weekEnd >= addDaysIso(today, -1)) cacheFor(apodSource.maxAge);

    const q = new URLSearchParams({ date_from: yymmddIso(weekStart), date_to: yymmddIso(weekEnd), per_page: "7" });
    const rows = await upstream.json<RawBasic[]>("APOD archive (science.nasa.gov)", `${APOD_BASIC}?${q}`);
    if (!Array.isArray(rows)) throw new SourceError("parse", "science.nasa.gov returned no list of APOD entries.");
    const entries = rows
      .filter((r) => isIsoDate(r?.date) && r.date >= weekStart && r.date <= weekEnd)
      .map(fromBasic)
      .sort((a, b) => b.date.localeCompare(a.date));

    let before: string | null = null;
    let after: string | null = null;
    if (!entries.length) [before, after] = await neighbours(upstream, weekStart, weekEnd, today);
    const data: ApodWeekData = { weekStart, weekEnd, entries, before, after };
    return data;
  },
};
