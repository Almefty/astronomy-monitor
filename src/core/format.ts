const nf = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", opts);
const int = nf({ maximumFractionDigits: 0 });
const compact = nf({ notation: "compact", maximumFractionDigits: 1 });

export const fmt = {
  int: (n: number) => int.format(n),
  compact: (n: number) => compact.format(n),
  fixed: (n: number, d = 1) => nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(n),
  sig: (n: number, digits = 2) => {
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 100) return int.format(n);
    return nf({ maximumSignificantDigits: digits }).format(n);
  },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Oct 14:20 UTC" — the dashboard shows UTC everywhere so sources line up. */
export function utc(iso: string | Date, withTime = true): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (!withTime) return day;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm} UTC`;
}

export function utcDate(iso: string | Date, year = false): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
}

/** Local time for "last updated" stamps (the user's own clock). */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "in 5 h", "3 d ago", "in 40 min". */
export function relative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  let txt: string;
  if (abs < min) return diff >= 0 ? "now" : "just now";
  if (abs < hour) txt = `${Math.round(abs / min)} min`;
  else if (abs < 2 * day) txt = `${Math.round(abs / hour)} h`;
  else txt = `${Math.round(abs / day)} d`;
  return diff >= 0 ? `in ${txt}` : `${txt} ago`;
}

/** Duration since a timestamp without direction words: "2 min", "3 h". */
export function age(iso: string, now = Date.now()): string {
  const r = relative(iso, now);
  return r === "just now" || r === "now" ? "moments" : r.replace(/^in /, "").replace(/ ago$/, "");
}

export const LY_PER_PC = 3.26156;

export function lightYears(pc: number | null): string {
  if (pc === null) return "distance unknown";
  const ly = pc * LY_PER_PC;
  return ly < 100 ? `${fmt.fixed(ly, ly < 10 ? 1 : 0)} ly` : `${fmt.int(ly)} ly`;
}

/** Human size analogy for an asteroid diameter in metres. */
export function sizeAnalogy(m: number): string {
  if (m < 4) return "car-sized";
  if (m < 12) return "bus-sized";
  if (m < 30) return "house-sized";
  if (m < 70) return "airliner-sized";
  if (m < 150) return "stadium-sized";
  if (m < 450) return "skyscraper-sized";
  if (m < 1500) return "hill-sized";
  return "mountain-sized";
}

export function metres(km: number): string {
  const m = km * 1000;
  return m < 1000 ? `${fmt.sig(m, 2)} m` : `${fmt.sig(km, 2)} km`;
}
