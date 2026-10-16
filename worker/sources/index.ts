import type { SourceId } from "../../shared/contract";
import { apodArchiveSource, apodSource } from "./apod";
import { exoplanetSource } from "./exoplanets";
import { gcnSource } from "./gcn";
import { goesSource } from "./goes";
import { neoSource } from "./neo";
import { orbitsSource } from "./orbits";
import { solarSource } from "./solar";
import { telescopeSource } from "./telescopes";
import type { SourceModule } from "./types";

/** Register new data sources here. */
export const SOURCES: { [K in SourceId]: SourceModule<K> } = {
  neo: neoSource,
  solar: solarSource,
  exoplanets: exoplanetSource,
  apod: apodSource,
  "apod-archive": apodArchiveSource,
  gcn: gcnSource,
  telescopes: telescopeSource,
  goes: goesSource,
  orbits: orbitsSource,
};

export function getSource(id: string): SourceModule | undefined {
  return (SOURCES as Record<string, SourceModule>)[id];
}
