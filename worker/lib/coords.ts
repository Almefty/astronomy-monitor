/**
 * Sky-coordinate extraction from free text (GCN Circulars) and from target names
 * (STScI schedules). Both are written by people, so every parser here is strict:
 * a value is only accepted when its format and range are unambiguous, and anything
 * doubtful is dropped rather than guessed. Positions are J2000 degrees.
 */

export interface TextPosition {
  ra: number;
  dec: number;
  /** 90% error radius in degrees, if stated next to the position. */
  errDeg: number | null;
  /** Character offset in the (whitespace-collapsed) text — earlier = more prominent. */
  at: number;
  /** Instrument named closest before the position ("XRT", "UVOT", …), if any. */
  instrument: string | null;
}

const INSTRUMENTS: [RegExp, string][] = [
  [/\bXRT\b/g, "Swift-XRT"], [/\bUVOT\b/g, "Swift-UVOT"], [/\bBAT\b/g, "Swift-BAT"], [/\bMXT\b/g, "SVOM/MXT"],
  [/\bECLAIRs\b/gi, "SVOM/ECLAIRs"], [/\bVT\b/g, "SVOM/VT"], [/\bWXT\b/g, "EP-WXT"], [/\bFXT\b/g, "EP-FXT"],
  [/\bGBM\b/g, "Fermi GBM"], [/\bLAT\b/g, "Fermi LAT"], [/\bMAXI\b/g, "MAXI"], [/\bIceCube\b/g, "IceCube"],
];

function mentions(text: string): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (const [re, label] of INSTRUMENTS) for (const m of text.matchAll(re)) out.push({ at: m.index!, label });
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The instrument a position belongs to: the first one named in the position's own paragraph
 * ("UVOT took a finding chart … RA(J2000) = …"), else the last one named before it.
 * `t` uses "¶" as the paragraph mark (see extractPositions).
 */
export function instrumentFor(t: string, at: number): string | null {
  const para = t.lastIndexOf("¶", at);
  const own = mentions(t.slice(para + 1, at));
  if (own.length) return own[0]!.label;
  const before = mentions(t.slice(Math.max(0, para - 1500), Math.max(0, para)));
  return before.length ? before[before.length - 1]!.label : null;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
// Sexagesimal RA: 17h 01m 21.4s · 17:01:21.42 · 17 01 21.42 (separators required between all parts).
const SEX_RA = String.raw`(\d{1,2})\s*(?:h|:|\s)\s*(\d{1,2})\s*(?:m|:|\s|')\s*(\d{1,2}(?:\.\d+)?)\s*s?`;
// Sexagesimal Dec: +01d 35' 25" · -17:41:32.0 · -21 33 37.9 · -17d40m11.38s
const SEX_DEC = String.raw`([+\-−–]?)\s?(\d{1,2})\s*(?:d|°|:|\s)\s*(\d{1,2})\s*(?:m|'|′|:|\s)\s*(\d{1,2}(?:\.\d+)?)\s*(?:s|"|″|'')?`;
const DEC_NUM = String.raw`([+\-−–]?\s?\d{1,3}(?:\.\d+)?)`;

const reSexRa = new RegExp(`^${SEX_RA}`);
const reSexDec = new RegExp(`^${SEX_DEC}`);
const reDecimal = new RegExp(`^${DEC_NUM}`);

function sign(s: string): number {
  return /[\-−–]/.test(s) ? -1 : 1;
}

/** Parse an RA value at the start of `s`: sexagesimal hours or decimal degrees. */
export function parseRaValue(s: string): number | null {
  const sx = reSexRa.exec(s);
  if (sx) {
    const h = Number(sx[1]), m = Number(sx[2]), sec = Number(sx[3]);
    if (h < 24 && m < 60 && sec < 60) return (h + m / 60 + sec / 3600) * 15;
    return null;
  }
  const d = reDecimal.exec(s);
  if (!d) return null;
  const raw = d[1]!.replace(/\s/g, "");
  // A bare integer RA ("RA: 17") is ambiguous (hours? degrees?) — require a decimal point or a unit.
  if (!raw.includes(".") && !/^\S+\s*(?:deg|°)/.test(s)) return null;
  const v = Number(raw.replace(/[−–]/, "-"));
  return v >= 0 && v < 360 ? v : null;
}

/** Parse a Dec value at the start of `s`: sexagesimal or decimal degrees. */
export function parseDecValue(s: string): number | null {
  const sx = reSexDec.exec(s);
  if (sx) {
    const d = Number(sx[2]), m = Number(sx[3]), sec = Number(sx[4]);
    if (d <= 90 && m < 60 && sec < 60) {
      const v = sign(sx[1]!) * (d + m / 60 + sec / 3600);
      return Math.abs(v) <= 90 ? v : null;
    }
    return null;
  }
  const dm = reDecimal.exec(s);
  if (!dm) return null;
  const v = Number(dm[1]!.replace(/\s/g, "").replace(/[−–]/, "-"));
  return Number.isFinite(v) && Math.abs(v) <= 90 ? v : null;
}

const UNIT_TO_DEG: [RegExp, number][] = [
  [/^(?:arc\s?sec(?:ond)?s?|"|″|'')/i, 1 / 3600],
  [/^(?:arc\s?min(?:ute)?s?|'|′)/i, 1 / 60],
  [/^(?:deg(?:ree)?s?|°)/i, 1],
];

/**
 * Find the error radius stated right after a position: the first "<number> <unit>" that
 * follows an error keyword ("uncertainty of 2.2 arcsec", "error radius of about 1.10 arc sec",
 * "radius of 2.17 arcmin", "statistical error of 0.32 deg").
 */
export function parseErrorRadius(window: string): number | null {
  const kw = /(uncertaint|error|radius|containment|c\.l\.)/i.exec(window);
  if (!kw) return null;
  const after = window.slice(kw.index, kw.index + 90);
  const re = new RegExp(`(${NUM})\\s*(arc\\s?sec(?:ond)?s?|arc\\s?min(?:ute)?s?|deg(?:ree)?s?|"|″|'|′|°)`, "gi");
  for (const m of after.matchAll(re)) {
    const v = Number(m[1]);
    for (const [u, f] of UNIT_TO_DEG) {
      if (u.test(m[2]!)) {
        const deg = v * f;
        // A plausible localization: 0.01″ … 60°.
        if (deg > 0 && deg <= 60) return deg;
      }
    }
  }
  return null;
}

/** IceCube style: "RA: 177.71 (+0.54/-0.53 deg 90% PSF containment)". Returns the largest half-width. */
function containment(s: string): number | null {
  const m = /^\s*\(\s*\+\s*(\d+(?:\.\d+)?)\s*\/?\s*-\s*(\d+(?:\.\d+)?)\s*deg/i.exec(s);
  return m ? Math.max(Number(m[1]), Number(m[2])) : null;
}

const LABEL_RA = String.raw`\bR\.?\s?A\.?(?![a-z])`;
const LABEL_DEC = String.raw`\bDec(?:l(?:ination)?)?\.?(?![a-z])`;
const EPOCH = String.raw`(?:\s*\(?J2000(?:\.0)?\)?)?`;
const ASSIGN = String.raw`\s*(?:=|:|is|of)?\s*`;

/**
 * All positions stated in a circular, in order of appearance. Handles
 *   "RA, Dec = 255.327, +1.590 deg" · "(R.A., Dec) = (297.193 deg, -36.587 deg)"
 *   "RA, Dec (J2000) = 01:27:09.74, +12:53:21.8"
 *   "RA (J2000): 17 01 21.42 / Dec (J2000): +01 35 19.4" · "RA = 138.6, Dec = 17.6"
 *   "R.A. = 11.629 deg, DEC = -17.694 deg" · IceCube "RA: 235.59 (+0.49/-0.5 deg …)"
 */
export function extractPositions(text: string): TextPosition[] {
  const t = text.replace(/\n[ \t]*\n/g, " ¶ ").replace(/\s+/g, " ");
  const out: TextPosition[] = [];
  const seen = new Set<number>();

  // 1) Combined label: "RA, Dec = a, b"
  const combined = new RegExp(`${LABEL_RA}\\s*,\\s*${LABEL_DEC}\\)?${EPOCH}${ASSIGN}\\(?\\s*`, "gi");
  for (const m of t.matchAll(combined)) {
    const start = m.index! + m[0].length;
    const rest = t.slice(start, start + 120);
    const ra = parseRaValue(rest);
    if (ra === null) continue;
    // Skip past the RA value to the separating comma.
    const comma = /^[^,]{1,40},\s*/.exec(rest);
    if (!comma) continue;
    const dec = parseDecValue(rest.slice(comma[0].length));
    if (dec === null) continue;
    const errWin = t.slice(start, start + 260);
    out.push({ ra, dec, errDeg: parseErrorRadius(errWin.slice(comma[0].length + 4)), at: m.index!, instrument: instrumentFor(t, m.index!) });
    seen.add(m.index!);
  }

  // 2) Separate labels: "RA … = a … Dec … = b" within a short span.
  const raLabel = new RegExp(`${LABEL_RA}${EPOCH}${ASSIGN}`, "gi");
  for (const m of t.matchAll(raLabel)) {
    if ([...seen].some((s) => Math.abs(s - m.index!) < 30)) continue;
    const start = m.index! + m[0].length;
    const rest = t.slice(start, start + 200);
    const ra = parseRaValue(rest);
    if (ra === null) continue;
    const raErr = containment(rest.replace(/^[^(]*?(?=\()/, ""));
    const decM = new RegExp(`${LABEL_DEC}${EPOCH}${ASSIGN}`, "i").exec(rest);
    if (!decM || decM.index > 140 || /\bR\.?\s?A\.?\s*[(=:]/i.test(rest.slice(3, decM.index))) continue;
    const decStart = decM.index + decM[0].length;
    const dec = parseDecValue(rest.slice(decStart));
    if (dec === null) continue;
    const decErr = containment(rest.slice(decStart).replace(/^[^(]*?(?=\()/, ""));
    let errDeg: number | null = null;
    if (raErr !== null || decErr !== null) {
      errDeg = Math.max((raErr ?? 0) * Math.cos((dec * Math.PI) / 180), decErr ?? 0);
    } else {
      errDeg = parseErrorRadius(t.slice(start + decStart, start + decStart + 260));
    }
    out.push({ ra, dec, errDeg, at: m.index!, instrument: instrumentFor(t, m.index!) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ */
/* Coordinates encoded in target names                                 */
/* ------------------------------------------------------------------ */

/**
 * Many catalog names carry their own J2000 position: "J095236+405249",
 * "SDSSJ124416.60+501014.0", "2MASS-J04285053+1844361", "SPT-S-J205239-5611.9",
 * "DW0936P2135" (P/M for +/−), "J2150-4652AB". Returns null unless the digits form
 * a valid position. `approx` is set when the name only gives hhmm / ddmm.
 */
export function positionFromName(name: string): { ra: number; dec: number; approx: boolean } | null {
  const m =
    /(?:^|[^A-Z0-9])(?:[A-Z]+-?)?(?:J|2MASS-?J?|DW)(\d{2})(\d{2})(\d{2})?(\.?\d*)([+\-PM])(\d{2})(\d{2})(\d{2})?(\.?\d*)/i.exec(name);
  if (!m) return null;
  const [, rh, rm, rs, rfrac, sg, dd, dm, ds, dfrac] = m as unknown as string[];
  const fracOf = (f: string | undefined) => (f ? Number(f.startsWith(".") ? `0${f}` : `0.${f}`) : 0);
  const h = Number(rh), mi = Number(rm);
  const d = Number(dd), dmi = Number(dm);
  if (h > 23 || mi > 59 || d > 89 || dmi > 59) return null;
  let raH: number;
  let approx = false;
  if (rs !== undefined && rs !== "") {
    const sec = Number(rs) + fracOf(rfrac);
    if (sec >= 60) return null;
    raH = h + mi / 60 + sec / 3600;
  } else {
    raH = h + (mi + fracOf(rfrac)) / 60; // "hhmm.m"
    approx = !rfrac;
  }
  let decD: number;
  if (ds !== undefined && ds !== "") {
    const sec = Number(ds) + fracOf(dfrac);
    if (sec >= 60) return null;
    decD = d + dmi / 60 + sec / 3600;
  } else {
    decD = d + (dmi + fracOf(dfrac)) / 60; // "ddmm.m"
    approx = approx || !dfrac;
  }
  const s = sg === "-" || sg!.toUpperCase() === "M" ? -1 : 1;
  return { ra: raH * 15, dec: s * decD, approx };
}

/**
 * Turn an STScI target name into something the CDS Sesame resolver understands:
 * "NGC-855" → "NGC 855", "-KSI01-CMA" → "ksi01 CMa", "GRW+70D5824" → "GRW +70 5824".
 */
export function resolverName(target: string): string {
  let n = target.trim();
  if (n.startsWith("-")) {
    // Bayer/Flamsteed star names are written "-BET-UMA".
    const parts = n.slice(1).split("-");
    if (parts.length === 2) return `${parts[0]!.toLowerCase()} ${parts[1]!.charAt(0)}${parts[1]!.slice(1).toLowerCase()}`;
  }
  n = n.replace(/^(NGC|IC|UGC|UGCA|PGC|ESO|HD|HIP|HR|GJ|LHS|WD|M|MESSIER|ABELL|TYC|BD|CD|LP|G|PSR|SN)-/i, "$1 ");
  n = n.replace(/^(BD|GRW|CD)([+-]\d{2})D(\d+)/i, "$1 $2 $3");
  return n;
}
