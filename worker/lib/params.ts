import { clampInt } from "./util";

/** Turns a raw query value into the value a source actually uses (never throws). */
export type Param<T extends string | number> = (raw: string | null) => T;
export type ParamSpec = Record<string, Param<string | number>>;
export type ParamValues<S extends ParamSpec> = { [K in keyof S]: ReturnType<S[K]> };

/** An integer clamped to [min, max]; anything unparseable becomes `fallback`. */
export const intParam =
  (min: number, max: number, fallback: number): Param<number> =>
  (raw) =>
    clampInt(raw, min, max, fallback);

/** One of a fixed set of strings; anything else becomes the first one (the default). */
export const oneOf =
  <T extends string>(...values: readonly [T, ...T[]]): Param<T> =>
  (raw) =>
    values.includes(raw as T) ? (raw as T) : values[0];

export function readParams<S extends ParamSpec>(spec: S, search: URLSearchParams): ParamValues<S> {
  const out: Record<string, string | number> = {};
  for (const [name, parse] of Object.entries(spec)) out[name] = parse(search.get(name));
  return out as ParamValues<S>;
}

/**
 * The query string a source would act on, in a fixed order with unknown parameters dropped.
 * The Worker cache is keyed by path + query, so `?days=07&x=1` and `?days=7` must become the
 * same URL, or anyone could bypass the cache (and reach the upstream APIs) with junk parameters.
 */
export function canonicalQuery(spec: ParamSpec | undefined, search: URLSearchParams): string {
  if (!spec) return "";
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(readParams(spec, search))) {
    if (value !== "") out.set(name, String(value));
  }
  const qs = out.toString();
  return qs ? `?${qs}` : "";
}
