import type { SourceId } from "../../shared/contract";
import { apodSource } from "./apod";
import { exoplanetSource } from "./exoplanets";
import { neoSource } from "./neo";
import { solarSource } from "./solar";
import type { SourceModule } from "./types";

/** Register new data sources here (v2: GCN Circulars, JWST/HST targets, GOES X-rays …). */
export const SOURCES: { [K in SourceId]: SourceModule<K> } = {
  neo: neoSource,
  solar: solarSource,
  exoplanets: exoplanetSource,
  apod: apodSource,
};

export function getSource(id: string): SourceModule | undefined {
  return (SOURCES as Record<string, SourceModule>)[id];
}
