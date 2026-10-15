import type { PanelDefinition } from "../core/panel";
import { apodPanel } from "./apod";
import { exoplanetPanel } from "./exoplanets";
import { gcnPanel } from "./gcn";
import { neoPanel } from "./neo";
import { solarPanel } from "./solar";
import { solarSystemPanel } from "./solarsystem";
import { telescopePanel } from "./telescopes";

/**
 * Panel order = page order. The 3D Solar System follows the close-approach panel it links to
 * (its three.js code is a separate chunk, loaded only when the panel is on screen).
 */
export const PANELS: PanelDefinition<any>[] = [neoPanel, apodPanel, solarSystemPanel, solarPanel, gcnPanel, telescopePanel, exoplanetPanel];
