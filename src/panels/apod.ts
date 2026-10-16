import { addDaysIso, APOD_FIRST, apodToday, isIsoDate, nearestDays, randomDay, weekStartOf } from "../../shared/apod";
import type { ApodData, ApodEntry, ApodWeekData } from "../../shared/contract";
import { ApiError, fetchSource, isRateLimited } from "../core/api";
import { h, icon, safeUrl } from "../core/dom";
import { utcDate } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";

const dateLabel = (d: string) => utcDate(`${d}T12:00:00Z`, true);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const longDate = (d: string) => `${WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${dateLabel(d)}`;

/** The page URL's `?apod=YYYY-MM-DD`: a shareable link to one day. */
const URL_PARAM = "apod";

function embedUrl(url: string): string | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  const u = new URL(safe);
  if (/^(www\.|m\.)?youtube\.com$/.test(u.hostname)) u.hostname = "www.youtube-nocookie.com";
  if (!/^(www\.youtube-nocookie\.com|player\.vimeo\.com)$/.test(u.hostname)) return null;
  u.protocol = "https:";
  return u.toString();
}

/**
 * A video this page can't play (Flash players, MPEG/QuickTime files, other hosts): the CSP stays as
 * strict as it is, so show the poster (if any) with a clear link instead of a broken player.
 */
function externalVideo(e: ApodEntry): HTMLElement {
  const poster = safeUrl(e.imageUrl);
  const page = safeUrl(e.permalink);
  // A link to the file only helps for downloadable movies (MPEG, QuickTime…), not for Flash players.
  const file = e.videoUrl && !/\.(?:swf|flv)(?:[?#]|$)/i.test(e.videoUrl) ? safeUrl(e.videoUrl) : null;
  return h(
    "div",
    { class: "apod-media apod-external" },
    poster ? h("img", { src: poster, alt: "", decoding: "async", referrerpolicy: "no-referrer", class: "apod-external-poster" }) : null,
    h(
      "div",
      { class: "apod-external-box" },
      icon(ICONS.play),
      h("p", null, "This video can’t be played here: it uses an older format or another site’s player."),
      h(
        "div",
        { class: "apod-external-links" },
        page ? h("a", { class: "btn", href: page, target: "_blank", rel: "noopener" }, "Watch on NASA’s site", icon(ICONS.external)) : null,
        file && file !== page ? h("a", { class: "btn btn-quiet", href: file, target: "_blank", rel: "noopener" }, "Open the video file", icon(ICONS.external)) : null,
      ),
    ),
  );
}

function media(e: ApodEntry): HTMLElement {
  const box = h("div", { class: "apod-media" });
  const fallback = (msg: string) => box.replaceChildren(h("div", { class: "no-media" }, msg));
  if (e.mediaType === "video") {
    if (e.videoKind === "file" && safeUrl(e.videoUrl)) {
      const v = h("video", { controls: true, preload: "metadata", playsinline: true, poster: safeUrl(e.imageUrl) ?? undefined, "aria-label": e.title });
      v.append(h("source", { src: safeUrl(e.videoUrl)! }));
      box.append(v);
      return box;
    }
    const src = e.videoKind === "embed" && e.videoUrl ? embedUrl(e.videoUrl) : null;
    if (src) {
      // Sandboxed: the players need scripts and their own origin (cookies-free YouTube, Vimeo) and may
      // open "Watch on YouTube/Vimeo" in a new tab, but can't navigate this page or open dialogs.
      const sandbox = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
      box.append(h("iframe", { sandbox, src, title: e.title, loading: "lazy", allow: "fullscreen; picture-in-picture; encrypted-media", referrerpolicy: "strict-origin-when-cross-origin" }));
      return box;
    }
    return externalVideo(e);
  }
  const src = safeUrl(e.imageUrl);
  if (!src) {
    fallback("This entry has no preview image — open it on NASA’s site.");
    return box;
  }
  const img = h("img", { src, alt: e.alt || e.title, decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => fallback("The image could not be loaded — open it on NASA’s site."));
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
  const what = e.mediaType === "video" ? "Video" : "Image";
  return h(
    "div",
    null,
    media(e),
    h("h3", { class: "apod-title" }, e.title || "Untitled entry"),
    h(
      "div",
      { class: "apod-meta" },
      h("span", { class: "mono" }, dateLabel(e.date)),
      // Always shown: most APOD images are copyrighted by their authors, not NASA.
      h("span", null, e.credit ? `${what} credit & copyright: ${e.credit}` : `${what} credit & copyright: see the entry on NASA’s site`),
    ),
    e.explanation ? text : null,
    h(
      "div",
      { class: "apod-links" },
      e.explanation ? more : null,
      hd ? h("a", { class: "btn apod-ext", href: hd, target: "_blank", rel: "noopener" }, "Full resolution", icon(ICONS.external)) : null,
      page ? h("a", { class: "btn apod-ext", href: page, target: "_blank", rel: "noopener" }, "View on NASA", icon(ICONS.external)) : null,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Archive browsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Archive weeks loaded in this visit, kept across re-renders (a refresh of today's picture keeps the
 * archive day on screen) and reused by "Random day" and the date picker. The Worker caches past weeks
 * for 30 days, so repeats rarely reach NASA either.
 */
const weeks = new Map<string, Promise<ApodWeekData>>();
/** The day on screen when it isn't today's picture (module state: survives a re-render). */
let shownDay: string | null = null;

function loadWeek(weekStart: string, signal: AbortSignal): Promise<ApodWeekData> {
  let p = weeks.get(weekStart);
  if (!p) {
    p = fetchSource("apod-archive", { week: weekStart }, signal).then((env) => env.data);
    weeks.set(weekStart, p);
    p.catch(() => weeks.delete(weekStart)); // a failure is retried next time
  }
  return p;
}

function linkedDay(): string | null {
  const v = new URLSearchParams(location.search).get(URL_PARAM);
  return isIsoDate(v) ? v : null;
}

function setLinkedDay(day: string | null) {
  const url = new URL(location.href);
  if (day) url.searchParams.set(URL_PARAM, day);
  else url.searchParams.delete(URL_PARAM);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

const errorText = (err: unknown) =>
  isRateLimited(err) ? "Too many requests — wait a minute, then try again." : err instanceof ApiError ? err.message : "Something went wrong.";

export const apodPanel: PanelDefinition<ApodData> = {
  id: "apod",
  title: "Astronomy Picture of the Day",
  subtitle: "Today’s featured image and the past week, explained by professional astronomers — or any day since June 1995",
  icon: ICONS.image,
  span: "span-5",
  source: { name: "NASA APOD (science.nasa.gov)", url: "https://science.nasa.gov/apod/" },

  async load(signal): Promise<PanelResult<ApodData>> {
    const env = await fetchSource("apod", {}, signal);
    return { data: env.data, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
  },

  render(root, { data }) {
    const controller = new AbortController();
    /** Today in New York (APOD's calendar), or the newest loaded entry if that is later. */
    const today = () => {
      const t = apodToday(new Date());
      return data.today.date > t ? data.today.date : t;
    };

    // --- Day bar: the shown date (also the date picker), Random day, Back to today.
    const dateText = h("span", { class: "apod-day-text" });
    const dateKind = h("span", { class: "apod-day-kind" });
    const dateBtn = h(
      "button",
      { type: "button", class: "apod-date-btn", "aria-label": "Choose a day from the APOD archive", title: "Choose a day (archive since 16 June 1995)" },
      icon(ICONS.calendar),
      h("span", { class: "apod-day-label" }, dateText, dateKind),
    );
    // Pointer taps land on the transparent input over the button (the only way iOS WebKit opens its
    // picker, see TASKS.md v3.1); the button underneath keeps keyboard focus and the label.
    const dateInput = h("input", { type: "date", class: "date-overlay-input", min: APOD_FIRST, max: today(), tabindex: "-1", "aria-hidden": "true" });
    const openPicker = () => {
      dateInput.max = today();
      try {
        dateInput.showPicker();
      } catch {
        /* not supported or not allowed: WebKit's own tap handling still opens it */
      }
    };
    dateInput.addEventListener("click", openPicker);
    dateBtn.addEventListener("click", openPicker);
    const randomBtn = h("button", { type: "button", class: "btn", title: "Open a random day from the archive" }, icon(ICONS.shuffle), "Random day");
    const todayBtn = h("button", { type: "button", class: "btn", hidden: true }, icon(ICONS.now), "Back to today");
    const bar = h(
      "div",
      { class: "apod-daybar" },
      h("div", { class: "apod-date-pick" }, dateBtn, dateInput),
      h("div", { class: "apod-day-actions" }, randomBtn, todayBtn),
    );
    const status = h("div", { class: "apod-status", role: "status", "aria-live": "polite" });

    const holder = h("div", { class: "apod-holder" });
    const stripHead = h("p", { class: "apod-strip-head" });
    const strip = h("div", { class: "filmstrip", role: "group", "aria-label": "Recent days" });

    let list: ApodEntry[] = data.recent;
    let token = 0; // newest archive action; older answers are ignored

    const setStatus = (...children: (Node | string | null)[]) => {
      status.replaceChildren(...children.filter((c): c is Node | string => c !== null));
      status.hidden = !status.firstChild;
    };
    const setBusy = (busy: boolean, btn?: HTMLButtonElement) => {
      for (const b of [randomBtn, todayBtn, dateBtn]) b.disabled = busy;
      dateInput.disabled = busy;
      btn?.classList.toggle("is-busy", busy);
      if (!busy) randomBtn.classList.remove("is-busy");
      holder.classList.toggle("is-loading", busy);
      root.setAttribute("aria-busy", String(busy));
    };
    const dayButton = (day: string, label = dateLabel(day)) => {
      const b = h("button", { type: "button", class: "btn btn-small" }, label);
      b.addEventListener("click", () => void openDay(day));
      return b;
    };

    const fillStrip = (entries: ApodEntry[], heading: string | null) => {
      strip.replaceChildren();
      strip.classList.toggle("is-week", heading !== null);
      stripHead.textContent = heading ?? "";
      stripHead.hidden = heading === null || entries.length < 2;
      for (const e of entries) {
        const thumb = safeUrl(e.thumbUrl);
        const b = h(
          "button",
          { type: "button", class: thumb ? null : "no-thumb", "data-date": e.date, title: `${dateLabel(e.date)} — ${e.title}`, "aria-label": `${dateLabel(e.date)}: ${e.title}` },
          thumb ? h("img", { src: thumb, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }) : null,
          e.mediaType === "video" ? icon(ICONS.play) : null,
          h("span", { class: "day" }, utcDate(`${e.date}T12:00:00Z`)),
        );
        b.querySelector("svg")?.classList.add("vid");
        b.addEventListener("click", () => select(e));
        strip.append(b);
      }
      strip.hidden = entries.length < 2;
    };

    /** Show one entry; the URL and the day bar follow (today's picture has no URL parameter). */
    function select(e: ApodEntry) {
      token++; // a click overrides an archive request still in flight
      setBusy(false);
      holder.replaceChildren(entryView(e));
      for (const b of strip.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.date === e.date));
      const isToday = e.date === data.today.date;
      shownDay = isToday ? null : e.date;
      setLinkedDay(shownDay);
      dateText.textContent = longDate(e.date);
      dateKind.textContent = isToday ? "Today’s picture" : list === data.recent ? "This week" : "From the archive";
      dateInput.value = e.date;
      todayBtn.hidden = isToday && list === data.recent;
    }

    function showToday() {
      list = data.recent;
      fillStrip(list, null);
      setStatus();
      select(data.today);
    }

    function showWeek(week: ApodWeekData, e: ApodEntry) {
      list = week.entries;
      fillStrip(list, `Week of ${dateLabel(week.weekStart)}`);
      select(e);
    }

    /** Open any day: from today's filmstrip if it's there, otherwise its archive week. */
    async function openDay(day: string): Promise<boolean> {
      if (day === data.today.date) {
        showToday();
        return true;
      }
      const t = today();
      setLinkedDay(shownDay); // a pending linked day the visitor didn't open is dropped once they choose another
      // When nothing new opens, the picker goes back to the day on screen.
      const keepShown = () => (dateInput.value = shownDay ?? data.today.date);
      if (day < APOD_FIRST) {
        keepShown();
        setStatus(h("span", null, `The APOD archive starts on ${dateLabel(APOD_FIRST)}. `), dayButton(APOD_FIRST, `Open ${dateLabel(APOD_FIRST)}`));
        return false;
      }
      if (day > t) {
        keepShown();
        setStatus(h("span", null, `There’s no picture for ${dateLabel(day)} yet. `), dayButton(data.today.date, "Show today’s"));
        return false;
      }
      const recent = data.recent.find((e) => e.date === day);
      if (recent) {
        list = data.recent;
        fillStrip(list, null);
        setStatus();
        select(recent);
        return true;
      }
      const my = ++token;
      setBusy(true);
      setStatus(`Loading ${dateLabel(day)}…`);
      try {
        const week = await loadWeek(weekStartOf(day), controller.signal);
        if (my !== token) return false;
        const e = week.entries.find((x) => x.date === day);
        if (e) {
          setStatus();
          showWeek(week, e);
          return true;
        }
        keepShown();
        // A day without an entry (17–19 Jun 1995, 30 Jun 2000, …): say so and offer the nearest days,
        // looking into the neighbouring week when the nearest one is there (one more cached request).
        let near = nearestDays(day, week);
        const side = !near.after && week.weekEnd < t ? 7 : !near.before && week.weekStart > APOD_FIRST ? -7 : 0;
        if (side) {
          const other = await loadWeek(addDaysIso(week.weekStart, side), controller.signal).catch(() => null);
          if (my !== token) return false;
          if (other) near = nearestDays(day, { ...week, entries: [...week.entries, ...other.entries] });
        }
        setStatus(
          h("span", null, `There’s no APOD for ${dateLabel(day)}. Nearest: `),
          near.before ? dayButton(near.before) : null,
          near.after ? dayButton(near.after) : null,
          !near.before && !near.after ? dayButton(data.today.date, "Show today’s") : null,
        );
        return false;
      } catch (err) {
        if (my !== token || controller.signal.aborted) return false;
        keepShown();
        const retry = h("button", { type: "button", class: "btn btn-small" }, "Try again");
        retry.addEventListener("click", () => void openDay(day));
        setStatus(h("span", null, `Couldn’t load ${dateLabel(day)}: ${errorText(err)} `), retry);
        return false;
      } finally {
        if (my === token) setBusy(false);
      }
    }

    /**
     * Random day: a uniformly random date, then a random entry of its week (so a missing day just
     * picks a neighbour). A failed week is retried quietly with another date; it never ends in an
     * error state — at worst the current picture stays and a short note says to try again.
     */
    async function openRandom() {
      setStatus();
      const current = shownDay ?? data.today.date;
      for (let attempt = 0; attempt < 4; attempt++) {
        const day = randomDay(today());
        const my = ++token;
        setBusy(true, randomBtn);
        try {
          const week = await loadWeek(weekStartOf(day), controller.signal);
          if (my !== token) return;
          const pool = week.entries.filter((e) => e.date !== current);
          if (!pool.length) continue;
          setBusy(false);
          showWeek(week, pool[Math.floor(Math.random() * pool.length)]!);
          return;
        } catch (err) {
          if (my !== token || controller.signal.aborted) return;
          if (isRateLimited(err)) {
            setBusy(false);
            setStatus(errorText(err));
            return;
          }
        }
      }
      setBusy(false);
      setStatus("NASA’s archive didn’t answer just now — try “Random day” again in a moment.");
    }

    dateInput.addEventListener("change", () => {
      if (isIsoDate(dateInput.value)) void openDay(dateInput.value);
    });
    randomBtn.addEventListener("click", () => void openRandom());
    todayBtn.addEventListener("click", showToday);

    root.append(bar, status, holder, stripHead, strip);
    root.append(
      h(
        "p",
        { class: "apod-rights" },
        "Pictures, videos and explanations are shown as published by NASA’s Astronomy Picture of the Day. Each image belongs to the credited author and may be copyrighted; it is not covered by this project’s license. ",
        h("a", { href: "https://science.nasa.gov/apod/about-apod/", target: "_blank", rel: "noopener" }, "About APOD"),
      ),
    );

    // Start with today's view; restore the archive day shown before a refresh (from memory, no request),
    // and offer a day linked in the URL (fetched only when the visitor asks: data loads on a button press).
    const wanted = shownDay ?? linkedDay();
    showToday();
    if (wanted && wanted !== data.today.date) {
      const inRecent = data.recent.find((e) => e.date === wanted);
      if (inRecent) select(inRecent);
      else if (weeks.has(weekStartOf(wanted))) void openDay(wanted);
      else {
        setLinkedDay(wanted); // keep the link shareable until the visitor decides
        const show = dayButton(wanted, `Show ${dateLabel(wanted)}`);
        show.classList.add("btn-primary");
        setStatus(h("span", null, `This link points to the picture of ${dateLabel(wanted)}. `), show);
      }
    }
    return () => {
      token++;
      controller.abort();
    };
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
