/**
 * Peloton ride data via Peloton's unofficial web API (the same one the web app
 * uses). Preferred auth: an Auth0 refresh token from one web login
 * (PELOTON_REFRESH_TOKEN + PELOTON_CLIENT_ID), renewed automatically and
 * rotated in HEALTH_CACHE. Fallback: a ~48 h bearer token copied from the web
 * app (PELOTON_BEARER_TOKEN). (Peloton retired the username/password
 * /auth/login endpoint in 2026.) Tokens never leave the server; the Peloton
 * user id is cached in HEALTH_CACHE.
 *
 * Unofficial: Peloton can change auth or response shapes without notice, so
 * every field is read defensively and missing data comes back as null.
 *
 * Calls:
 *   GET  /api/user/{id}/workouts?joins=…       → paged workout list
 *   GET  /api/workout/{id}/performance_graph   → summaries, averages, per-sample metrics
 *   GET  /api/me                               → user id, FTP
 */
import { isoInTz } from "./dates";

const API = "https://api.onepeloton.com";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const RIDE_TTL_SECONDS = 365 * 24 * 60 * 60;
/** A finished ride is final once it ended this long ago (Peloton finalises
 *  summaries a few minutes after the class ends). */
const SETTLE_SECONDS = 60 * 60;
/** Uncached rides whose detail is fetched per call; keeps us under the
 *  Workers subrequest limit. The caller calls again when `pending`. */
export const MAX_DETAIL_FETCHES = 8;
/** Seconds between performance-graph samples. 5 s keeps power-zone time accurate. */
const EVERY_N = 5;

type Obj = Record<string, any>;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const r0 = (n: number | null) => (n === null ? null : Math.round(n));

/** Compact list-level view of one workout (no per-ride detail call needed). */
export type PelotonWorkout = {
  id: string;
  date: string;
  start: string;
  discipline: string;
  status: string;
  duration_min: number | null;
  total_output_kj: number | null;
  title: string | null;
  instructor: string | null;
  /** GPS outdoor ride logged in the Peloton app: no bike metrics. */
  outdoor: boolean;
  start_epoch: number;
  end_epoch: number | null;
  ftp_w: number | null;
};

/** Per-ride detail, built from the performance graph. */
export type PelotonRide = {
  id: string;
  date: string;
  /** Local start time, HH:MM. */
  start: string;
  discipline: string;
  title: string | null;
  instructor: string | null;
  duration_min: number | null;
  total_output_kj: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  avg_cadence_rpm: number | null;
  max_cadence_rpm: number | null;
  avg_resistance_pct: number | null;
  max_resistance_pct: number | null;
  avg_speed_mph: number | null;
  distance: number | null;
  distance_unit: string | null;
  /** Peloton's own estimate. Not logged anywhere; the watch's calories are the ones that reach LoseIt. */
  peloton_kcal: number | null;
  /** From the HR source paired to the bike (Sean pairs his watch); null if none was paired. */
  avg_hr: number | null;
  max_hr: number | null;
  hr_zone_min: Record<string, number> | null;
  ftp_w: number | null;
  ftp_source: string | null;
  /** Minutes in Peloton power zones 1-7; null when no FTP is known. */
  power_zone_min: Record<string, number> | null;
  /** Class type from the title, for comparing like with like. */
  ride_type: RideType;
  /** Best rolling average power over 5 and 20 minutes (null if the ride is shorter). */
  best_5min_w: number | null;
  best_20min_w: number | null;
  /** avg_power_w / avg_hr — aerobic efficiency; compare only within one ride_type (endurance). */
  efficiency: number | null;
};

export type RideType = "ftp_test" | "pz_max" | "pz_endurance" | "power_zone" | "warm_up" | "cool_down" | "low_impact" | "other";

/** Pure: Peloton class title → ride type. */
export function rideType(title: string | null): RideType {
  const t = (title ?? "").toLowerCase();
  if (/\bftp\b/.test(t)) return "ftp_test";
  if (/power zone max|\bpz max\b/.test(t)) return "pz_max";
  if (/power zone endurance|\bpze\b/.test(t)) return "pz_endurance";
  if (/power zone|\bpz\b/.test(t)) return "power_zone";
  if (/warm ?up/.test(t)) return "warm_up";
  if (/cool ?down/.test(t)) return "cool_down";
  if (/low impact|recovery/.test(t)) return "low_impact";
  return "other";
}

/** Pure: best rolling-average power over `secs`, from samples every `everyN` seconds. */
export function bestAverage(values: unknown[], secs: number, everyN: number): number | null {
  const n = Math.round(secs / everyN);
  const v = values.map((x) => num(x) ?? 0);
  if (n <= 0 || v.length < n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += v[i];
  let best = sum;
  for (let i = n; i < v.length; i++) {
    sum += v[i] - v[i - n];
    if (sum > best) best = sum;
  }
  return Math.round(best / n);
}

/** Peloton's power-zone bands as a fraction of FTP (lower bounds of zones 2-7). */
const PZ_BOUNDS = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];

export function powerZone(watts: number, ftp: number): number {
  const pct = watts / ftp;
  let z = 1;
  for (const b of PZ_BOUNDS) if (pct >= b) z++;
  return z;
}

/** Minutes in each power zone from evenly spaced output samples. */
export function powerZoneMinutes(values: unknown[], ftp: number, everyN: number): Record<string, number> {
  const secs: Record<string, number> = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 };
  for (const v of values) {
    const w = num(v);
    if (w === null) continue;
    secs[`z${powerZone(w, ftp)}`] += everyN;
  }
  return Object.fromEntries(Object.entries(secs).map(([k, s]) => [k, r1(s / 60)!]));
}

function hhmm(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(epoch * 1000));
}

/** Pure: one item of the workouts list → compact workout. */
export function parseWorkout(w: Obj, fallbackTz: string): PelotonWorkout | null {
  const startEpoch = num(w.start_time) ?? num(w.created_at);
  if (!w?.id || startEpoch === null) return null;
  const tz = validTz(w.timezone) ? w.timezone : fallbackTz;
  const end = num(w.end_time);
  const ride = (w.ride ?? {}) as Obj;
  const work = num(w.total_work);
  return {
    id: String(w.id),
    date: isoInTz(new Date(startEpoch * 1000), tz),
    start: hhmm(startEpoch, tz),
    discipline: String(w.fitness_discipline ?? "unknown"),
    status: String(w.status ?? ""),
    duration_min: end !== null && end > startEpoch ? r1((end - startEpoch) / 60) : r1((num(ride.duration) ?? NaN) / 60),
    total_output_kj: work === null ? null : r1(work / 1000),
    title: ride.title ?? null,
    instructor: ride.instructor?.name ?? null,
    outdoor: /\boutdoor\b/i.test(String(ride.title ?? "")) || /outdoor/i.test(String(w.workout_type ?? "")),
    start_epoch: startEpoch,
    end_epoch: end,
    ftp_w: num(w.ftp_info?.ftp) || null,
  };
}

function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Pure: performance_graph response + list-level workout → ride detail. */
export function buildRide(w: PelotonWorkout, graph: Obj, ftp: { ftp: number | null; source: string | null }, everyN = EVERY_N): PelotonRide {
  const metric = (slug: string) => (Array.isArray(graph?.metrics) ? graph.metrics : []).find((m: Obj) => m?.slug === slug) as Obj | undefined;
  const summary = (slug: string) => (Array.isArray(graph?.summaries) ? graph.summaries : []).find((m: Obj) => m?.slug === slug) as Obj | undefined;
  const avgSummary = (slug: string) => num((Array.isArray(graph?.average_summaries) ? graph.average_summaries : []).find((m: Obj) => m?.slug === slug)?.value);

  const output = metric("output");
  const cadence = metric("cadence");
  const resistance = metric("resistance");
  const speed = metric("speed");
  const hr = metric("heart_rate");
  const dist = summary("distance");

  let hrZones: Record<string, number> | null = null;
  if (Array.isArray(hr?.zones) && hr!.zones.length) {
    hrZones = {};
    for (const [i, z] of hr!.zones.entries()) hrZones[String(z.slug ?? `zone${i + 1}`).replace(/^zone/, "z")] = r1((num(z.duration) ?? 0) / 60)!;
  } else if (graph?.effort_zones?.heart_rate_zone_durations) {
    const d = graph.effort_zones.heart_rate_zone_durations as Obj;
    hrZones = {};
    for (const [k, v] of Object.entries(d)) {
      const m = /z(\d)/.exec(k);
      if (m) hrZones[`z${m[1]}`] = r1((num(v) ?? 0) / 60)!;
    }
  }

  const outputValues = Array.isArray(output?.values) ? output!.values : [];
  const kj = num(summary("total_output")?.value) ?? w.total_output_kj;
  const avgW = num(output?.average_value) ?? avgSummary("avg_output");
  const durSecs = num(graph?.duration);

  return {
    id: w.id,
    date: w.date,
    start: w.start,
    discipline: w.discipline,
    title: w.title,
    instructor: w.instructor,
    duration_min: durSecs !== null ? r1(durSecs / 60) : w.duration_min,
    total_output_kj: r1(kj),
    avg_power_w: r0(avgW),
    max_power_w: r0(num(output?.max_value)),
    avg_cadence_rpm: r0(num(cadence?.average_value) ?? avgSummary("avg_cadence")),
    max_cadence_rpm: r0(num(cadence?.max_value)),
    avg_resistance_pct: r0(num(resistance?.average_value) ?? avgSummary("avg_resistance")),
    max_resistance_pct: r0(num(resistance?.max_value)),
    avg_speed_mph: r1(num(speed?.average_value) ?? avgSummary("avg_speed")),
    distance: r1(num(dist?.value)),
    distance_unit: dist?.display_unit ?? null,
    peloton_kcal: r0(num(summary("calories")?.value)),
    avg_hr: r0(num(hr?.average_value)),
    max_hr: r0(num(hr?.max_value)),
    hr_zone_min: hrZones,
    ftp_w: ftp.ftp,
    ftp_source: ftp.ftp ? ftp.source : null,
    power_zone_min: ftp.ftp && outputValues.length ? powerZoneMinutes(outputValues, ftp.ftp, everyN) : null,
    ride_type: rideType(w.title),
    best_5min_w: bestAverage(outputValues, 300, everyN),
    best_20min_w: bestAverage(outputValues, 1200, everyN),
    efficiency: avgW && num(hr?.average_value) ? Math.round((avgW / num(hr!.average_value)!) * 100) / 100 : null,
  };
}

/** Per-day Peloton totals for get_daily_metrics. */
export type PelotonDay = { peloton_kj: number; peloton_min: number; peloton_avg_w: number | null };

export function dailyTotals(workouts: PelotonWorkout[]): Map<string, PelotonDay> {
  const acc = new Map<string, { kj: number; secs: number; workSecs: number }>();
  for (const w of workouts) {
    const secs = (w.duration_min ?? 0) * 60;
    const a = acc.get(w.date) ?? { kj: 0, secs: 0, workSecs: 0 };
    a.secs += secs;
    if (w.total_output_kj !== null) { a.kj += w.total_output_kj; a.workSecs += secs; }
    acc.set(w.date, a);
  }
  const out = new Map<string, PelotonDay>();
  for (const [d, a] of acc) {
    out.set(d, {
      peloton_kj: r1(a.kj)!,
      peloton_min: Math.round(a.secs / 60),
      peloton_avg_w: a.workSecs > 0 ? Math.round((a.kj * 1000) / a.workSecs) : null,
    });
  }
  return out;
}

export type PelotonOpts = {
  /** Bearer token copied from the logged-in Peloton web app (Authorization header). Fallback when no refresh token is set. */
  token?: string;
  /** Auth0 refresh token from a Peloton web login (seed). When set with `clientId`, access tokens renew themselves. */
  refreshToken?: string;
  /** Auth0 client id of the Peloton web app (from the same login's /oauth/token request). */
  clientId?: string;
  cache?: KVNamespace;
  /** Scopes cache keys; same `v1:<user>:` prefix as the health cache so delete_my_data clears it. */
  userId: string;
  timeZone: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export const TOKEN_HELP =
  "Get a fresh one: log in at members.onepeloton.com, open DevTools → Network, click any api.onepeloton.com request, copy the Authorization header value after 'Bearer ', and save it as the PELOTON_BEARER_TOKEN Worker secret.";

export const REFRESH_HELP =
  "Re-seed it: open a private window, open DevTools → Network (Preserve log on), log in at members.onepeloton.com, select the POST to auth.onepeloton.com/oauth/token, copy refresh_token from its Response, close the private window, and save it as the PELOTON_REFRESH_TOKEN Worker secret.";

const AUTH_URL = "https://auth.onepeloton.com/oauth/token";
/** Global (not per-user) KV key for the rotating Peloton credentials; delete_my_data leaves it alone. */
export const AUTH_KEY = "peloton-auth:v1";
/** Renew this long before the access token's stated expiry. */
const EXPIRY_SKEW_MS = 10 * 60 * 1000;

type AuthState = { seed: string; refresh_token: string; access_token: string | null; expires_at: number };

/** Short fingerprint of the seed refresh token, so a newly pasted secret replaces the stored chain. */
async function fingerprint(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Keeps a Peloton access token alive with Auth0 refresh tokens. Peloton's
 * access tokens last ~48 h and refresh tokens are single-use (rotated on every
 * renewal), so the newest refresh token is written to KV before the new access
 * token is used. The secret is only the seed: once rotated, KV holds the live one.
 */
export class PelotonAuth {
  private memo: Promise<string> | null = null;
  constructor(
    private readonly o: { refreshToken: string; clientId: string; cache?: KVNamespace; fetchImpl: typeof fetch; now: () => number },
  ) {}

  private async load(): Promise<AuthState> {
    const seed = await fingerprint(this.o.refreshToken.trim());
    let st: AuthState | null = null;
    try { st = (await this.o.cache?.get<AuthState>(AUTH_KEY, "json")) ?? null; } catch { /* miss */ }
    if (st && st.seed === seed) return st;
    return { seed, refresh_token: this.o.refreshToken.trim(), access_token: null, expires_at: 0 };
  }

  /** A valid access token, renewing it when it is missing, near expiry, or `force`d (after a 401). */
  async accessToken(force = false): Promise<string> {
    if (!force && this.memo) return this.memo;
    const p = this.resolve(force);
    this.memo = p;
    p.catch(() => { if (this.memo === p) this.memo = null; });
    return p;
  }

  private async resolve(force: boolean): Promise<string> {
    const st = await this.load();
    if (!force && st.access_token && st.expires_at - EXPIRY_SKEW_MS > this.o.now()) return st.access_token;
    return this.renew(st);
  }

  private async renew(st: AuthState): Promise<string> {
    // Check before spending the single-use refresh token.
    if (!this.o.cache) throw new Error("Peloton refresh needs the HEALTH_CACHE KV binding to store the rotated refresh token.");
    const res = await this.o.fetchImpl(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "google-health-mcp" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.o.clientId, refresh_token: st.refresh_token }).toString(),
    });
    let j: Obj = {};
    try { j = (await res.json()) as Obj; } catch { /* non-JSON */ }
    if (!res.ok || !j.access_token) {
      // Another request may have just rotated the chain: use its token if so.
      const latest = await this.load();
      if (latest.refresh_token !== st.refresh_token && latest.access_token && latest.expires_at > this.o.now()) return latest.access_token;
      const code = typeof j.error === "string" ? j.error : `HTTP ${res.status}`;
      throw new Error(`Peloton refresh token was rejected (${code}). ${REFRESH_HELP}`);
    }
    const next: AuthState = {
      seed: st.seed,
      // RFC 6749 §6: keep the old refresh token if the response omits a new one.
      refresh_token: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : st.refresh_token,
      access_token: String(j.access_token),
      expires_at: this.o.now() + (num(j.expires_in) ?? 172800) * 1000,
    };
    await this.o.cache.put(AUTH_KEY, JSON.stringify(next));
    return next.access_token!;
  }
}

export class PelotonClient {
  private pelotonUserId: string | null = null;
  private me: Obj | null = null;
  private meFtp: { ftp: number | null; source: string | null } | undefined;
  private readonly f: typeof fetch;
  private readonly now: () => number;

  private readonly auth: PelotonAuth | null;

  constructor(private readonly o: PelotonOpts) {
    this.f = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => Date.now());
    this.auth = o.refreshToken && o.clientId
      ? new PelotonAuth({ refreshToken: o.refreshToken, clientId: o.clientId, cache: o.cache, fetchImpl: this.f, now: this.now })
      : null;
  }

  private key(k: string) { return `v1:${this.o.userId}:peloton1:${k}`; }

  private async raw(path: string): Promise<Obj> {
    const send = (token: string) =>
      this.f(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, "Peloton-Platform": "web", "User-Agent": "google-health-mcp" },
      });
    let res: Response;
    if (this.auth) {
      res = await send(await this.auth.accessToken());
      // The stored access token can be revoked early: renew once and retry.
      if (res.status === 401) res = await send(await this.auth.accessToken(true));
      if (res.status === 401 || res.status === 403) throw new Error(`Peloton rejected a freshly renewed access token (HTTP ${res.status}). ${REFRESH_HELP}`);
    } else {
      res = await send((this.o.token ?? "").replace(/^Bearer\s+/i, "").trim());
      if (res.status === 401 || res.status === 403) throw new Error(`Peloton rejected the bearer token (HTTP ${res.status}); it has probably expired. ${TOKEN_HELP}`);
    }
    if (!res.ok) throw new Error(`Peloton GET ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return (await res.json()) as Obj;
  }

  private async getMe(): Promise<Obj> {
    if (!this.me) this.me = await this.raw("/api/me");
    return this.me;
  }

  /** Peloton user id: from KV when known, else /api/me (cached for a week). */
  private async getUserId(): Promise<string> {
    if (this.pelotonUserId) return this.pelotonUserId;
    try {
      const hit = await this.o.cache?.get(this.key("user"));
      if (hit) return (this.pelotonUserId = hit);
    } catch { /* miss */ }
    const id = (await this.getMe())?.id;
    if (!id) throw new Error("Peloton /api/me returned no user id.");
    this.pelotonUserId = String(id);
    try { await this.o.cache?.put(this.key("user"), this.pelotonUserId, { expirationTtl: SESSION_TTL_SECONDS }); } catch { /* best effort */ }
    return this.pelotonUserId;
  }

  /** GET with the bearer token; `{user}` in the path is replaced by the Peloton user id. */
  async get(path: string): Promise<Obj> {
    if (path.includes("{user}")) path = path.replace("{user}", encodeURIComponent(await this.getUserId()));
    return this.raw(path);
  }

  /** Workouts whose local start date is in [start, end], newest first, paging back until older than start. */
  async listWorkouts(start: string, end: string, opts: { limit?: number } = {}): Promise<PelotonWorkout[]> {
    const out: PelotonWorkout[] = [];
    const limit = opts.limit ?? 100;
    for (let page = 0; page < 10; page++) {
      const j = await this.get(`/api/user/{user}/workouts?joins=ride,ride.instructor&limit=${limit}&page=${page}&sort_by=-created`);
      const data: Obj[] = Array.isArray(j?.data) ? j.data : [];
      let older = false;
      for (const raw of data) {
        const w = parseWorkout(raw, this.o.timeZone);
        if (!w) continue;
        if (w.date < start) { older = true; continue; }
        if (w.date <= end) out.push(w);
      }
      const more = j?.show_next ?? (num(j?.page_count) !== null ? page + 1 < num(j.page_count)! : data.length === limit);
      if (older || !more || !data.length) break;
    }
    return out;
  }

  private async ftpFromMe(): Promise<{ ftp: number | null; source: string | null }> {
    if (this.meFtp) return this.meFtp;
    try {
      const me = await this.getMe();
      const set = num(me?.cycling_workout_ftp) || num(me?.cycling_ftp);
      const est = num(me?.estimated_cycling_ftp);
      this.meFtp = set ? { ftp: set, source: String(me?.cycling_ftp_source ?? "set") } : est ? { ftp: est, source: "estimated" } : { ftp: null, source: null };
    } catch {
      this.meFtp = { ftp: null, source: null };
    }
    return this.meFtp;
  }

  /**
   * Ride detail for [start, end]. Settled rides are cached for a year; at most
   * MAX_DETAIL_FETCHES uncached rides are fetched per call (`pending` = more remain).
   */
  async rides(start: string, end: string, opts: { discipline?: "cycling" | "all" } = {}): Promise<{ rides: PelotonRide[]; pending: boolean }> {
    const workouts = (await this.listWorkouts(start, end)).filter(
      (w) => w.status.toUpperCase() === "COMPLETE" && (opts.discipline === "all" || (w.discipline === "cycling" && !w.outdoor)),
    );
    const rides: PelotonRide[] = [];
    let fetched = 0;
    let pending = false;
    for (const w of workouts) {
      const k = this.key(`ride2:${w.id}`);
      try {
        const hit = await this.o.cache?.get<PelotonRide>(k, "json");
        if (hit) { rides.push(hit); continue; }
      } catch { /* miss */ }
      if (fetched >= MAX_DETAIL_FETCHES) { pending = true; continue; }
      fetched++;
      const graph = await this.get(`/api/workout/${encodeURIComponent(w.id)}/performance_graph?every_n=${EVERY_N}`);
      const ftp = w.ftp_w ? { ftp: w.ftp_w, source: "ride" } : await this.ftpFromMe();
      const ride = buildRide(w, graph, ftp);
      rides.push(ride);
      const settled = (w.end_epoch ?? w.start_epoch) * 1000 < this.now() - SETTLE_SECONDS * 1000;
      if (settled) {
        try { await this.o.cache?.put(k, JSON.stringify(ride), { expirationTtl: RIDE_TTL_SECONDS }); } catch { /* best effort */ }
      }
    }
    rides.sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));
    return { rides, pending };
  }
}
