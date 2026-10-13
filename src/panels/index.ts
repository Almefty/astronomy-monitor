import type { PanelDefinition } from "../core/panel";
import { apodPanel } from "./apod";
import { exoplanetPanel } from "./exoplanets";
import { gcnPanel } from "./gcn";
import { neoPanel } from "./neo";
import { solarPanel } from "./solar";
import { telescopePanel } from "./telescopes";

/**
 * Panel order = page order. v3 (3D Solar System, lazy-loaded) slots in here; its live
 * animation can follow live mode's visible/hidden state (see core/live.ts).
 */
export const PANELS: PanelDefinition<any>[] = [neoPanel, apodPanel, solarPanel, gcnPanel, telescopePanel, exoplanetPanel];
