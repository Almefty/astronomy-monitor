/**
 * The browser's own copy of each spacecraft's last good orbital elements, so passes keep working when
 * CelesTrak doesn't answer (from Cloudflare it often fails with HTTP 522). Pure: the panel reads and writes
 * the store with src/core/storage.ts (key SAVED_ELEMENTS_KEY) and passes it in.
 *
 * A copy is used for at most SAVED_MAX_AGE_DAYS, counted from the elements' epoch (the time the orbit
 * describes, which is what limits SGP4's accuracy), not from when it was saved; older copies are dropped.
 */

import type { Envelope, SatelliteElements, SatellitesData } from "../../shared/contract";
import { age } from "../core/format";

export const SAVED_ELEMENTS_KEY = "sky:elements";
export const SAVED_MAX_AGE_DAYS = 3;
const DAY = 86_400_000;
/** The Worker's default; only used when every spacecraft comes from this browser's copy. */
const STALE_AFTER_DAYS = 7;

/** One spacecraft's last good elements as kept in this browser. */
export interface SavedElements {
  el: SatelliteElements;
  /** When the page received them (the answer's fetchedAt). */
  savedAt: string;
}
/** Keyed by NORAD catalog number. */
export type SavedStore = Record<string, SavedElements>;

export function isSatelliteElements(x: unknown): x is SatelliteElements {
  const s = x as SatelliteElements | null;
  return (
    !!s && typeof s === "object" && typeof s.id === "number" && typeof s.name === "string" && typeof s.stdMag === "number" &&
    typeof s.epoch === "string" && Number.isFinite(Date.parse(s.epoch)) && !!s.omm && typeof s.omm === "object" && s.omm.NORAD_CAT_ID === s.id
  );
}

const epochMs = (el: SatelliteElements) => Date.parse(el.epoch);

/** True while a saved copy may stand in for fresh elements. */
export function savedUsable(el: SatelliteElements, now: number): boolean {
  return now - epochMs(el) <= SAVED_MAX_AGE_DAYS * DAY;
}

/** The store as read from storage: anything malformed or too old is dropped. */
export function readSaved(raw: unknown, now: number): SavedStore {
  const out: SavedStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const entry = v as SavedElements | null;
    if (!entry || typeof entry !== "object" || typeof entry.savedAt !== "string" || !isSatelliteElements(entry.el)) continue;
    if (String(entry.el.id) !== key || !savedUsable(entry.el, now)) continue;
    out[key] = entry;
  }
  return out;
}

/** The store with this answer's elements added (each kept only if newer than the copy already saved). */
export function rememberElements(store: SavedStore, data: SatellitesData, fetchedAt: string, now: number): SavedStore {
  const out: SavedStore = { ...store };
  for (const s of data.satellites) {
    if (!isSatelliteElements(s)) continue;
    const have = out[String(s.id)];
    if (have && epochMs(have.el) >= epochMs(s)) continue;
    // Stored without the server's flag: in this browser it is simply the last good copy.
    const { saved: _saved, ...el } = s;
    out[String(s.id)] = { el, savedAt: fetchedAt };
  }
  return readSaved(out, now);
}

export interface Filled {
  data: SatellitesData;
  /** Spacecraft whose elements come from this browser's copy. */
  fromBrowser: number[];
}

/**
 * Fills in spacecraft the server couldn't load from this browser's copies. `data` null means the whole
 * request failed: everything usable in the store is used (null if nothing is). Objects CelesTrak answered
 * for without elements (`kind: "missing"`) are left as they are; a copy the server saved is replaced by
 * a newer one from this browser.
 */
export function fillFromSaved(data: SatellitesData | null, store: SavedStore, now: number): Filled | null {
  const usable = (id: number) => {
    const s = store[String(id)];
    return s && savedUsable(s.el, now) ? s.el : null;
  };
  if (!data) {
    const satellites = Object.values(store).map((s) => s.el).filter((el) => savedUsable(el, now));
    if (!satellites.length) return null;
    return { data: { satellites, unavailable: [], staleAfterDays: STALE_AFTER_DAYS }, fromBrowser: satellites.map((s) => s.id) };
  }
  const fromBrowser: number[] = [];
  const satellites = data.satellites.map((s) => {
    const mine = s.saved ? usable(s.id) : null;
    if (mine && epochMs(mine) > epochMs(s)) {
      fromBrowser.push(s.id);
      return mine;
    }
    return s;
  });
  const unavailable: SatellitesData["unavailable"] = [];
  for (const u of data.unavailable) {
    const mine = u.kind === "missing" ? null : usable(u.id);
    if (mine) {
      satellites.push(mine);
      fromBrowser.push(u.id);
    } else {
      unavailable.push(u);
    }
  }
  return { data: { ...data, satellites, unavailable }, fromBrowser };
}

/** When the newest of the copies used was saved (the panel's fetchedAt when everything is from this browser). */
export function newestSavedAt(store: SavedStore, ids: number[]): string | null {
  const times = ids.map((id) => store[String(id)]?.savedAt).filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  return times.length ? new Date(Math.max(...times.map((t) => Date.parse(t)))).toISOString() : null;
}

/**
 * The passes section's plain note for a spacecraft predicted from a saved copy, e.g. "Hubble: orbit from 5 h ago
 * (saved in this browser), CelesTrak didn’t answer." Null when its elements are fresh.
 */
export function savedCopyNote(sat: SatelliteElements, fromBrowser: boolean, wholeLoadFailed: boolean, now = Date.now()): string | null {
  const where = fromBrowser ? "saved in this browser" : sat.saved ? "saved by this site’s server" : null;
  if (!where) return null;
  const why = wholeLoadFailed ? "the latest orbits couldn’t be loaded" : "CelesTrak didn’t answer";
  return `${sat.name}: orbit from ${age(sat.epoch, now)} ago (${where}), ${why}.`;
}

/** Where the store lives: src/core/storage.ts in the panel, a Map in tests. */
export interface SavedIo {
  read(): unknown;
  write(store: SavedStore): void;
}

export type ElementsOutcome =
  | { ok: true; envelope: Envelope<SatellitesData>; data: SatellitesData; fromBrowser: number[] }
  | { ok: false; error: unknown; data: SatellitesData | null; fromBrowser: number[]; fetchedAt: string | null };

/**
 * Loads the elements with `get` and keeps this browser's copy up to date. On success, spacecraft the server
 * couldn't load are filled in from the copy; when the request fails, every copy at most 3 days old is used
 * (plus `prev`, the elements on screen, in case storage is blocked). Never throws: a failure is an outcome.
 */
export async function loadElements(
  get: () => Promise<Envelope<SatellitesData>>,
  io: SavedIo,
  prev: { data: SatellitesData; fetchedAt: string } | null,
  now = Date.now(),
): Promise<ElementsOutcome> {
  const store = readSaved(io.read(), now);
  try {
    const envelope = await get();
    const next = rememberElements(store, envelope.data, envelope.fetchedAt, now);
    io.write(next);
    const filled = fillFromSaved(envelope.data, next, now)!;
    return { ok: true, envelope, data: filled.data, fromBrowser: filled.fromBrowser };
  } catch (error) {
    const candidates = prev ? rememberElements(store, prev.data, prev.fetchedAt, now) : store;
    const filled = fillFromSaved(null, candidates, now);
    return { ok: false, error, data: filled?.data ?? null, fromBrowser: filled?.fromBrowser ?? [], fetchedAt: filled ? newestSavedAt(candidates, filled.fromBrowser) : null };
  }
}
