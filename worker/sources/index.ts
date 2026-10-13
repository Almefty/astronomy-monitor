import type { SourceId } from "../../shared/contract";
import { apodSource } from "./apod";
import { exoplanetSource } from "./exoplanets";
import { gcnSource } from "./gcn";
import { goesSource } from "./goes";
import { neoSource } from "./neo";
import { solarSource } from "./solar";
import { telescopeSource } from "./telescopes";
import type { SourceModule } from "./types";

/** Register new data sources here (v3: JPL orbital elements for the 3D Solar System …). */
export const SOURCES: { [K in SourceId]: SourceModule<K> } = {
  neo: neoSource,
  solar: solarSource,
  exoplanets: exoplanetSource,
  apod: apodSource,
  gcn: gcnSource,
  telescopes: telescopeSource,
  goes: goesSource,
};

export function getSource(id: string): SourceModule | undefined {
  return (SOURCES as Record<string, SourceModule>)[id];
}
