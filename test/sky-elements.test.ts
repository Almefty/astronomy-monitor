import { describe, expect, it } from "vitest";
import type { Envelope, SatelliteElements, SatellitesData } from "../shared/contract";
import {
  fillFromSaved, loadElements, readSaved, rememberElements, SAVED_MAX_AGE_DAYS, savedCopyNote, type SavedIo, type SavedStore,
} from "../src/viz/sky-elements";
import { ommEpochMs, SATELLITE_LIST, slimOmm } from "../worker/sources/satellites";
import ref from "./fixtures/satellites-reference.json";

/*
 * The browser's fallback for CelesTrak failures: the last good elements per spacecraft are kept in
 * localStorage (src/core/storage.ts) and used for at most 3 days, counted from the elements' epoch.
 * Fixture epochs: ISS 1 Nov 2026 05:00, Tiangong 00:08, Hubble 02:56 (UTC).
 */

const OMM = ref.celestrak.omm as unknown as Record<string, unknown[]>;
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 1, 6);

function elements(id: number): SatelliteElements {
  const s = SATELLITE_LIST.find((x) => x.id === id)!;
  const omm = slimOmm(OMM[id], id)!;
  return { ...s, epoch: new Date(ommEpochMs(omm.EPOCH)!).toISOString(), omm };
}
const ISS = elements(25544), TIANGONG = elements(48274), HUBBLE = elements(20580);
const all = (): SatellitesData => ({ satellites: [ISS, TIANGONG, HUBBLE], unavailable: [], staleAfterDays: 7 });

describe("saved elements (pure)", () => {
  it("keeps the newest copy per spacecraft and drops anything malformed or older than 3 days", () => {
    expect(SAVED_MAX_AGE_DAYS).toBe(3);
    let store = rememberElements({}, all(), new Date(T0).toISOString(), T0);
    expect(Object.keys(store).sort()).toEqual(["20580", "25544", "48274"]);
    // An older epoch never replaces a newer one; the server's "saved" flag isn't stored.
    const older = { ...ISS, epoch: new Date(Date.parse(ISS.epoch) - H).toISOString() };
    store = rememberElements(store, { ...all(), satellites: [older, { ...HUBBLE, saved: true }] }, new Date(T0 + H).toISOString(), T0 + H);
    expect(store["25544"]!.el.epoch).toBe(ISS.epoch);
    expect(store["25544"]!.savedAt).toBe(new Date(T0).toISOString());
    expect(store["20580"]!.el.saved).toBeUndefined();

    // 3 days after each epoch the copy is gone: on 4 Nov 04:00 only the ISS (epoch 05:00) is left.
    expect(Object.keys(readSaved(store, Date.UTC(2026, 10, 4, 4)))).toEqual(["25544"]);
    expect(readSaved(store, Date.UTC(2026, 10, 4, 6))).toEqual({});
    // Malformed entries, wrong keys, wrong shapes.
    expect(readSaved({ "25544": { el: { ...ISS, omm: null }, savedAt: "x" }, "1": { el: ISS, savedAt: "x" } }, T0)).toEqual({});
    expect(readSaved([ISS], T0)).toEqual({});
    expect(readSaved("junk", T0)).toEqual({});
  });

  it("fills in spacecraft the server couldn't load, but not ones CelesTrak has no elements for", () => {
    const store = rememberElements({}, all(), new Date(T0).toISOString(), T0);
    const partial: SatellitesData = {
      satellites: [ISS],
      unavailable: [
        { id: 48274, name: "Tiangong", reason: "CelesTrak has no current elements for it.", kind: "missing" },
        { id: 20580, name: "Hubble", reason: "CelesTrak GP elements (Hubble) answered HTTP 522", kind: "failed" },
      ],
      staleAfterDays: 7,
    };
    const filled = fillFromSaved(partial, store, T0 + 5 * H)!;
    expect(filled.data.satellites.map((s) => s.name)).toEqual(["ISS", "Hubble"]);
    expect(filled.fromBrowser).toEqual([20580]);
    expect(filled.data.unavailable.map((u) => u.name)).toEqual(["Tiangong"]);
    // Answers without `kind` (older deploys) count as failed.
    const legacy = fillFromSaved({ ...partial, unavailable: [{ id: 20580, name: "Hubble", reason: "HTTP 522" }] }, store, T0 + H)!;
    expect(legacy.fromBrowser).toEqual([20580]);
    // Too old: the failure stays as it is.
    const late = fillFromSaved(partial, store, Date.UTC(2026, 10, 4, 6))!;
    expect(late.fromBrowser).toEqual([]);
    expect(late.data.unavailable.map((u) => u.name)).toEqual(["Tiangong", "Hubble"]);
  });

  it("prefers this browser's copy over an older one the server saved", () => {
    const newer = { ...HUBBLE, epoch: new Date(Date.parse(HUBBLE.epoch) + 2 * H).toISOString() };
    const store = rememberElements({}, { ...all(), satellites: [newer] }, new Date(T0).toISOString(), T0);
    const filled = fillFromSaved({ ...all(), satellites: [ISS, { ...HUBBLE, saved: true }] }, store, T0 + H)!;
    expect(filled.data.satellites.map((s) => [s.name, s.epoch, !!s.saved])).toEqual([["ISS", ISS.epoch, false], ["Hubble", newer.epoch, false]]);
    expect(filled.fromBrowser).toEqual([20580]);
    // A fresh element set is never replaced.
    expect(fillFromSaved(all(), store, T0 + H)!.fromBrowser).toEqual([]);
  });

  it("uses every usable copy when the whole request failed, and nothing once they're too old", () => {
    const store = rememberElements({}, all(), new Date(T0).toISOString(), T0);
    expect(fillFromSaved(null, store, T0 + 5 * H)!.fromBrowser.sort()).toEqual([20580, 25544, 48274]);
    expect(fillFromSaved(null, store, Date.UTC(2026, 10, 4, 6))).toBeNull();
    expect(fillFromSaved(null, {}, T0)).toBeNull();
  });

  it("says plainly where a spacecraft's orbit comes from", () => {
    const now = Date.parse(HUBBLE.epoch) + 5 * H;
    expect(savedCopyNote(HUBBLE, true, false, now)).toBe("Hubble: orbit from 5 h ago (saved in this browser), CelesTrak didn’t answer.");
    expect(savedCopyNote({ ...HUBBLE, saved: true }, false, false, now)).toBe("Hubble: orbit from 5 h ago (saved by this site’s server), CelesTrak didn’t answer.");
    expect(savedCopyNote(HUBBLE, true, true, now + DAY)).toBe("Hubble: orbit from 29 h ago (saved in this browser), the latest orbits couldn’t be loaded.");
    expect(savedCopyNote(HUBBLE, false, false, now)).toBeNull();
  });
});

describe("loading with saved elements (the panel's load())", () => {
  /** Storage as src/core/storage.ts does it: JSON in a string store (here a Map). */
  function memoryIo(): SavedIo & { raw: () => unknown } {
    let text: string | null = null;
    return { read: () => (text ? JSON.parse(text) : null), write: (store) => void (text = JSON.stringify(store)), raw: () => (text ? JSON.parse(text) : null) };
  }
  const envelope = (data: SatellitesData, at: number, notices: Envelope<SatellitesData>["notices"] = []): Envelope<SatellitesData> => ({
    source: "satellites", fetchedAt: new Date(at).toISOString(), data, upstream: [], notices,
  });
  const fails = () => Promise.reject(new Error("CelesTrak GP elements (ISS) did not respond within 12 s."));

  it("saves good elements and predicts a spacecraft the server couldn't load from them", async () => {
    const io = memoryIo();
    const first = await loadElements(async () => envelope(all(), T0), io, null, T0);
    expect(first).toMatchObject({ ok: true, fromBrowser: [] });
    expect(Object.keys(io.raw() as SavedStore).sort()).toEqual(["20580", "25544", "48274"]);

    // Five hours later Hubble fails on the server.
    const partial: SatellitesData = { satellites: [ISS, TIANGONG], unavailable: [{ id: 20580, name: "Hubble", reason: "HTTP 522", kind: "failed" }], staleAfterDays: 7 };
    const second = await loadElements(async () => envelope(partial, T0 + 5 * H), io, null, T0 + 5 * H);
    if (!second.ok) throw new Error("expected success");
    expect(second.data.satellites.map((s) => s.name)).toEqual(["ISS", "Tiangong", "Hubble"]);
    expect(second.data.unavailable).toEqual([]);
    expect(second.fromBrowser).toEqual([20580]);
    // The copy keeps its original save time.
    expect((io.raw() as SavedStore)["20580"]!.savedAt).toBe(new Date(T0).toISOString());
  });

  it("keeps passes from saved copies when the whole request fails, and drops copies older than 3 days", async () => {
    const io = memoryIo();
    await loadElements(async () => envelope(all(), T0), io, null, T0);

    const res = await loadElements(fails, io, null, T0 + 5 * H); // a new visit: storage alone
    if (res.ok) throw new Error("expected failure");
    expect((res.error as Error).message).toContain("12 s");
    expect(res.fromBrowser.sort()).toEqual([20580, 25544, 48274]);
    expect(res.fetchedAt).toBe(new Date(T0).toISOString());

    // On 4 Nov 06:00 every copy is more than 3 days old: no passes (the panel shows the current message).
    const late = await loadElements(fails, io, { data: res.data!, fetchedAt: res.fetchedAt! }, Date.UTC(2026, 10, 4, 6));
    expect(late).toMatchObject({ ok: false, data: null, fromBrowser: [], fetchedAt: null });
    // The next successful load writes the store without them.
    await loadElements(async () => envelope({ ...all(), satellites: [] }, Date.UTC(2026, 10, 4, 6)), io, null, Date.UTC(2026, 10, 4, 6));
    expect(io.raw()).toEqual({});
  });

  it("uses the elements on screen when storage is blocked", async () => {
    const blocked: SavedIo = { read: () => null, write: () => {} };
    const first = await loadElements(async () => envelope(all(), T0), blocked, null, T0);
    if (!first.ok) throw new Error("expected success");
    const res = await loadElements(fails, blocked, { data: first.data, fetchedAt: first.envelope.fetchedAt }, T0 + H);
    expect(res.data!.satellites).toHaveLength(3);
    expect(res.fromBrowser.sort()).toEqual([20580, 25544, 48274]);
  });
});
