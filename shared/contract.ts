/**
 * The JSON contract between the Worker (/api/*) and the frontend.
 *
 * Every source is normalized into a small, stable shape here so that upstream
 * API changes (which happen: DONKI and APOD both moved in Sept 2026) only ever
 * touch one Worker module, never the visualizations.
 */

export type SourceId = "neo" | "solar" | "exoplanets" | "apod";

export type KeyMode = "secret" | "demo";

/** One HTTP call the Worker made to an upstream service. URLs never contain the API key. */
export interface UpstreamCall {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
}

export interface Notice {
  level: "info" | "warning";
  text: string;
}

export interface Envelope<T> {
  source: SourceId;
  fetchedAt: string;
  data: T;
  upstream: UpstreamCall[];
  notices: Notice[];
}

export type ErrorKind = "timeout" | "unreachable" | "upstream" | "parse" | "bad-request" | "internal";

export interface ApiErrorBody {
  source: string;
  fetchedAt: string;
  error: { kind: ErrorKind; message: string; hint?: string };
  upstream: UpstreamCall[];
}

export interface SourceInfo {
  id: SourceId;
  title: string;
  provider: string;
  docsUrl: string;
}

export interface StatusResponse {
  env: "development" | "production";
  nasaKey: KeyMode;
  sources: SourceInfo[];
}

/* ------------------------------------------------------------------ */
/* Near-Earth object close approaches (JPL SSD/CNEOS CAD API)          */
/* ------------------------------------------------------------------ */

export interface CloseApproach {
  /** Primary designation, e.g. "2026 TR3" or "99942". */
  des: string;
  /** Human-friendly name, e.g. "99942 Apophis (2004 MN4)" or "(2026 TR3)". */
  name: string;
  /** Close-approach time (TDB, within ~70 s of UTC) as ISO-8601. */
  time: string;
  /** 3-sigma uncertainty of the time, as reported (e.g. "< 00:01", "00:02", "1_03:20"). */
  timeSigma: string;
  distAu: number;
  distMinAu: number;
  distMaxAu: number;
  /** Nominal distance in lunar distances (1 LD = 384,400 km). */
  distLd: number;
  distKm: number;
  /** Velocity relative to Earth at close approach, km/s. */
  vRelKms: number;
  /** Absolute magnitude H (brightness proxy for size); null if unknown. */
  h: number | null;
  /** Measured diameter in km when JPL has one. */
  diameterKm: number | null;
  /** Size range estimated from H for albedo 0.25 (min) .. 0.05 (max), km. */
  estDiameterKm: { min: number; max: number } | null;
  /** Potentially Hazardous Asteroid flag (from a second CAD query with pha=true). */
  pha: boolean;
  orbitId: string;
  /** JPL Small-Body Database page. */
  sbdbUrl: string;
}

export interface NeoData {
  windowStart: string;
  windowEnd: string;
  distMaxAu: number;
  approaches: CloseApproach[];
}

/* ------------------------------------------------------------------ */
/* Solar activity (NASA DONKI, hosted by CCMC)                         */
/* ------------------------------------------------------------------ */

export interface Flare {
  id: string;
  begin: string;
  peak: string;
  end: string | null;
  /** GOES class string, e.g. "M1.0". */
  classType: string;
  /** Peak 1–8 Å X-ray flux implied by the class, W/m². */
  flux: number;
  /** Class letter A/B/C/M/X. */
  letter: string;
  region: number | null;
  location: string;
  linkedIds: string[];
  link: string;
  note: string;
}

export interface CmeEarthImpact {
  /** Predicted shock arrival at Earth (WSA-ENLIL), if any. */
  arrival: string | null;
  glancingBlow: boolean;
  /** Predicted Kp range for the arrival, if modelled. */
  kpMin: number | null;
  kpMax: number | null;
}

export interface Cme {
  id: string;
  start: string;
  /** Time the leading edge reached 21.5 solar radii (from the most accurate analysis). */
  time21_5: string | null;
  speed: number | null;
  halfAngle: number | null;
  /** Stonyhurst heliographic latitude/longitude of the direction; longitude 0 = towards Earth, + = west. */
  lat: number | null;
  lon: number | null;
  /** CME type: S (<500 km/s) C (500–999) O (1000–1999) R (2000–2999) ER (>3000). */
  type: string | null;
  sourceLocation: string;
  earth: CmeEarthImpact | null;
  linkedIds: string[];
  note: string;
  link: string;
}

export interface KpReading {
  time: string;
  kp: number;
  source: string;
}

export interface GeoStorm {
  id: string;
  start: string;
  maxKp: number;
  /** NOAA G-scale 1..5 derived from max Kp. */
  gScale: number;
  readings: KpReading[];
  linkedIds: string[];
  link: string;
}

export interface SolarData {
  start: string;
  end: string;
  days: number;
  flares: Flare[];
  cmes: Cme[];
  storms: GeoStorm[];
  /** Which of the three DONKI feeds loaded (partial results are still returned). */
  feeds: { flares: boolean; cmes: boolean; storms: boolean };
}

/* ------------------------------------------------------------------ */
/* Exoplanets (NASA Exoplanet Archive TAP)                             */
/* ------------------------------------------------------------------ */

export interface Planet {
  name: string;
  host: string;
  discYear: number | null;
  method: string;
  facility: string;
  periodDays: number | null;
  radiusEarth: number | null;
  massEarth: number | null;
  eqTempK: number | null;
  insolation: number | null;
  distPc: number | null;
  ra: number | null;
  dec: number | null;
  starTeffK: number | null;
}

export interface NewPlanet extends Planet {
  /** Date the planet first appeared in the archive. */
  added: string;
}

export interface ExoplanetData {
  /** Confirmed-planet count; null if that (optional) query was slow — the catalog length is used instead. */
  total: number | null;
  windowDays: number;
  recent: NewPlanet[];
}

/**
 * The full confirmed-planet catalog, as compact column arrays
 * (built in the browser from the CSV served by /api/exoplanets/catalog).
 */
export const CATALOG_COLUMNS = [
  "pl_name",
  "hostname",
  "disc_year",
  "discoverymethod",
  "pl_orbper",
  "pl_rade",
  "pl_bmasse",
  "sy_dist",
  "ra",
  "dec",
] as const;

/* ------------------------------------------------------------------ */
/* Astronomy Picture of the Day                                        */
/* ------------------------------------------------------------------ */

export interface ApodEntry {
  date: string;
  title: string;
  mediaType: "image" | "video" | "other";
  /** Display-sized image (or video thumbnail when available). */
  imageUrl: string | null;
  /** Full-resolution image. */
  hdUrl: string | null;
  thumbUrl: string | null;
  /** For videos: an embeddable player URL (YouTube/Vimeo) or a direct video file. */
  videoUrl: string | null;
  videoKind: "embed" | "file" | null;
  explanation: string;
  credit: string;
  alt: string;
  permalink: string;
}

export interface ApodData {
  /** Which service the entries came from. */
  via: "science.nasa.gov" | "api.nasa.gov";
  today: ApodEntry;
  /** Recent days, newest first (includes today). */
  recent: ApodEntry[];
}

export type SourceDataMap = {
  neo: NeoData;
  solar: SolarData;
  exoplanets: ExoplanetData;
  apod: ApodData;
};
