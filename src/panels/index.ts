import type { PanelDefinition } from "../core/panel";
import { apodPanel } from "./apod";
import { exoplanetPanel } from "./exoplanets";
import { gcnPanel } from "./gcn";
import { neoPanel } from "./neo";
import { skyPanel } from "./sky";
import { solarPanel } from "./solar";
import { solarSystemPanel } from "./solarsystem";
import { telescopePanel } from "./telescopes";

/**
 * Panel order = page order. "Sky tonight" follows the picture of the day (its satellite.js code is a
 * separate chunk, loaded once there are orbits and a location). The 3D Solar System follows the
 * close-approach panel it links to (its three.js code is a separate chunk, loaded only when the panel is on screen).
 */
export const PANELS: PanelDefinition<any>[] = [neoPanel, apodPanel, skyPanel, solarSystemPanel, solarPanel, gcnPanel, telescopePanel, exoplanetPanel];
