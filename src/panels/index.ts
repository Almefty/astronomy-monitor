import type { PanelDefinition } from "../core/panel";
import { apodPanel } from "./apod";
import { exoplanetPanel } from "./exoplanets";
import { neoPanel } from "./neo";
import { solarPanel } from "./solar";

/**
 * Panel order = page order. v2 panels (GCN all-sky explosions, JWST/HST targets,
 * live GOES X-rays, 3D solar system) slot in here.
 */
export const PANELS: PanelDefinition<any>[] = [neoPanel, apodPanel, solarPanel, exoplanetPanel];
