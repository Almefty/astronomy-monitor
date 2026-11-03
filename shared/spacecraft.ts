/**
 * The spacecraft the "Sky tonight" panel predicts passes for. The one place to add or remove one. Shared:
 * the Worker asks CelesTrak for these, and the panel names the ones it has no orbit for at all.
 *
 * `stdMag` is the standard magnitude (1,000 km range, half illuminated) from Mike McCants' qs.mag
 * file, as carried in Stellarium's satellite catalogue (plugins/Satellites/resources/satellites.json,
 * updated 2026-06-24). These are rough: real brightness depends on attitude and solar panels, and
 * Tiangong's value may predate its 2022 modules (likely too faint).
 */
export const SATELLITE_LIST: readonly { id: number; name: string; stdMag: number }[] = [
  { id: 25544, name: "ISS", stdMag: -2.5 },
  { id: 48274, name: "Tiangong", stdMag: 1.87 },
  { id: 20580, name: "Hubble", stdMag: 1.5 },
];

/** "ISS", "ISS and Hubble", "ISS, Tiangong and Hubble". */
export function listNames(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
