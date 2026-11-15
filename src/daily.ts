/**
 * Compact one-row-per-day metrics, built for dashboards: a long date range in a
 * single small response instead of megabytes of raw sleep stages and sessions.
 *
 * The range is fetched in fixed two-month blocks (Jan–Feb, Mar–Apr, …) so each
 * block stays under the API's 90-day cap and every block that ends before
 * today is served from the client's KV cache on later loads.
 */
import type { GoogleHealthClient } from "./google-health";
import { nextDayIso } from "./dates";

export type DailyRow = {
  date: string;
  hrv_ms: number | null;
  rhr_bpm: number | null;
  sleep_h: number | null;
  deep_min: number | null;
  rem_min: number | null;
  nap_min: number | null;
  /** Bedtime in hours from midnight of the wake date: -0.5 = 11:30 PM, 1.5 = 1:30 AM. */
  bed_h: number | null;
  /** Wake time in hours after midnight. */
  wake_h: number | null;
  steps: number | null;
  zone_min: number | null;
  skate_min: number;
  lift_min: number;
  walk_min: number;
  ride_min: number;
  other_min: number;
  kcal_in: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  /** Saturated fat summed from the day's logged food items. */
  sat_fat_g: number | null;
  /** True when a logged food item is oatmeal/oats; null when no food was logged. */
  oatmeal: boolean | null;
  weight_lb: number | null;
  bf_pct: number | null;
};

type Obj = Record<string, any>;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const civil = (d: Obj | undefined): string | null =>
  d && d.year ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;

/** Local calendar date of an instant, using the record's own UTC offset ("-18000s"). */
export function localDate(time: string, offset?: string): string {
  const secs = offset ? parseFloat(offset) : 0;
  const t = new Date(new Date(time).getTime() + (Number.isFinite(secs) ? secs : 0) * 1000);
  return t.toISOString().slice(0, 10);
}

/** Two-month blocks (Jan–Feb, Mar–Apr, …) covering [start, end], clipped to the range. */
export function blocks(start: string, end: string): [string, string][] {
  const out: [string, string][] = [];
  let [y, m] = start.split("-").map(Number);
  m = m % 2 === 0 ? m - 1 : m; // align to odd month
  while (true) {
    const bStart = `${y}-${String(m).padStart(2, "0")}-01`;
    let ey = y, em = m + 2;
    if (em > 12) { em -= 12; ey += 1; }
    const nextStart = `${ey}-${String(em).padStart(2, "0")}-01`;
    const bEnd = new Date(Date.UTC(ey, em - 1, 1) - 86400000).toISOString().slice(0, 10);
    if (bStart > end) break;
    out.push([bStart < start ? start : bStart, bEnd > end ? end : bEnd]);
    y = ey; m = em;
    if (nextStart > end) break;
  }
  return out;
}

function points(resp: unknown, key: "dataPoints" | "rollupDataPoints"): Obj[] {
  const arr = (resp as Obj | null)?.[key];
  return Array.isArray(arr) ? arr : [];
}

function classify(type: string): "skate" | "lift" | "walk" | "ride" | "other" {
  const t = type.toUpperCase();
  // Sean's skate sessions are often started as the generic "Sport".
  if (t.includes("SKATE") || t === "SPORT") return "skate";
  if (t.includes("WEIGHT") || t.includes("STRENGTH")) return "lift";
  if (t.includes("WALK") || t.includes("HIK")) return "walk";
  if (t.includes("BIK") || t.includes("CYCL") || t.includes("SPIN")) return "ride";
  return "other";
}

/** Oatmeal or oats by name, but not oat milk, oat creamer or the like. */
export function isOatmeal(name: string): boolean {
  return /\boat(s|meal)?\b/i.test(name) && !/milk|creamer|bar\b|cookie/i.test(name);
}

/** Pure: merge raw API responses for one range into rows keyed by date. */
export function buildRows(start: string, end: string, raw: {
  hrv: unknown[]; rhr: unknown[]; sleep: unknown[]; exercise: unknown[];
  azm: unknown[]; steps: unknown[]; nutrition: unknown[]; weight: unknown[]; bodyFat: unknown[];
  /** Individual nutrition-log items (reconcile). The daily rollup omits sugar and saturated fat. */
  foods?: unknown[];
}): DailyRow[] {
  const rows = new Map<string, DailyRow>();
  for (let d = start; d <= end; d = nextDayIso(d)) {
    rows.set(d, {
      date: d, hrv_ms: null, rhr_bpm: null, sleep_h: null, deep_min: null, rem_min: null, nap_min: null, bed_h: null, wake_h: null,
      steps: null, zone_min: null, skate_min: 0, lift_min: 0, walk_min: 0, ride_min: 0, other_min: 0,
      kcal_in: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, sugar_g: null,
      sat_fat_g: null, oatmeal: null, weight_lb: null, bf_pct: null,
    });
  }
  const at = (d: string | null) => (d ? rows.get(d) : undefined);

  for (const p of raw.hrv.flatMap((r) => points(r, "dataPoints"))) {
    const h = p.dailyHeartRateVariability;
    const row = at(civil(h?.date));
    if (row) row.hrv_ms = r1(num(h.averageHeartRateVariabilityMilliseconds));
  }
  for (const p of raw.rhr.flatMap((r) => points(r, "dataPoints"))) {
    const h = p.dailyRestingHeartRate;
    const row = at(civil(h?.date));
    if (row) row.rhr_bpm = num(h.beatsPerMinute);
  }
  const seen = new Set<string>();
  const once = (p: Obj, iv: Obj) => {
    const k = String(p.dataPointName ?? `${iv.startTime}|${iv.endTime}`);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  for (const p of raw.sleep.flatMap((r) => points(r, "dataPoints"))) {
    const s = p.sleep;
    if (!s?.interval || !once(p, s.interval)) continue;
    const row = at(localDate(s.interval.endTime, s.interval.endUtcOffset));
    if (!row) continue;
    const asleep = num(s.summary?.minutesAsleep) ?? 0;
    if (s.metadata?.nap) {
      row.nap_min = (row.nap_min ?? 0) + asleep;
      continue;
    }
    const stage = (t: string) =>
      num((s.summary?.stagesSummary ?? []).find((x: Obj) => x.type === t)?.minutes) ?? 0;
    row.sleep_h = r1((row.sleep_h ?? 0) + asleep / 60);
    const hoursOf = (t: string, off?: string) => {
      const secs = off ? parseFloat(off) : 0;
      const d = new Date(new Date(t).getTime() + (Number.isFinite(secs) ? secs : 0) * 1000);
      return { date: d.toISOString().slice(0, 10), h: d.getUTCHours() + d.getUTCMinutes() / 60 };
    };
    if (s.interval.startTime) {
      const b = hoursOf(s.interval.startTime, s.interval.startUtcOffset);
      const bed = Math.round((b.date < row.date ? b.h - 24 : b.h) * 100) / 100;
      if (row.bed_h === null || bed < row.bed_h) row.bed_h = bed;
    }
    const w = hoursOf(s.interval.endTime, s.interval.endUtcOffset);
    const wake = Math.round(w.h * 100) / 100;
    if (row.wake_h === null || wake > row.wake_h) row.wake_h = wake;
    row.deep_min = (row.deep_min ?? 0) + stage("DEEP");
    row.rem_min = (row.rem_min ?? 0) + stage("REM");
  }
  // Workouts: one session per real activity. Two sources can log the same
  // activity, so a session that mostly overlaps a longer one is dropped.
  type Sess = { date: string; start: number; end: number; mins: number; kind: string };
  const sessions: Sess[] = [];
  for (const p of raw.exercise.flatMap((r) => points(r, "dataPoints"))) {
    const e = p.exercise;
    if (!e?.interval || !once(p, e.interval)) continue;
    const date = localDate(e.interval.startTime, e.interval.startUtcOffset);
    if (!rows.has(date)) continue;
    const start = new Date(e.interval.startTime).getTime();
    const end = new Date(e.interval.endTime).getTime();
    const secs = num(String(e.activeDuration ?? "").replace(/s$/, "")) ?? (end - start) / 1000;
    sessions.push({ date, start, end, mins: secs / 60, kind: classify(String(e.exerciseType ?? "")) });
  }
  sessions.sort((a, b) => b.mins - a.mins);
  const kept: Sess[] = [];
  for (const x of sessions) {
    const dup = kept.some((k) => {
      const overlap = Math.min(k.end, x.end) - Math.max(k.start, x.start);
      return overlap > 0.5 * (x.end - x.start);
    });
    if (dup) continue;
    kept.push(x);
    const row = rows.get(x.date)!;
    const key = `${x.kind}_min` as "skate_min";
    row[key] = Math.round(row[key] + x.mins);
  }
  for (const p of raw.azm.flatMap((r) => points(r, "rollupDataPoints"))) {
    const a = p.activeZoneMinutes;
    const row = at(civil(p.civilStartTime?.date));
    if (row && a) row.zone_min = (num(a.sumInFatBurnHeartZone) ?? 0) + (num(a.sumInCardioHeartZone) ?? 0) + (num(a.sumInPeakHeartZone) ?? 0);
  }
  for (const p of raw.steps.flatMap((r) => points(r, "rollupDataPoints"))) {
    const row = at(civil(p.civilStartTime?.date));
    if (row) row.steps = num(p.steps?.countSum);
  }
  for (const p of raw.nutrition.flatMap((r) => points(r, "rollupDataPoints"))) {
    const n = p.nutritionLog;
    const row = at(civil(p.civilStartTime?.date));
    if (!row || !n) continue;
    const nutrient = (k: string) => r1(num((n.nutrients ?? []).find((x: Obj) => x.nutrient === k)?.quantity?.gramsSum));
    row.kcal_in = num(n.energy?.kcalSum) === null ? null : Math.round(num(n.energy.kcalSum)!);
    row.protein_g = nutrient("PROTEIN");
    row.fiber_g = nutrient("DIETARY_FIBER");
    row.sugar_g = nutrient("SUGAR") ?? nutrient("SUGARS") ?? nutrient("TOTAL_SUGARS");
    row.carbs_g = r1(num(n.totalCarbohydrate?.gramsSum));
    row.fat_g = r1(num(n.totalFat?.gramsSum));
  }
  const foodSeen = new Set<string>();
  // When items are available, they are the source of truth for sugar (the
  // rollup rarely carries it); clear it so it is not counted twice.
  if ((raw.foods ?? []).some((r) => points(r, "dataPoints").length)) for (const row of rows.values()) row.sugar_g = null;
  for (const p of (raw.foods ?? []).flatMap((r) => points(r, "dataPoints"))) {
    const n = p.nutritionLog;
    if (!n) continue;
    const k = String(p.dataPointName ?? "");
    if (k) { if (foodSeen.has(k)) continue; foodSeen.add(k); }
    const row = at(civil(n.interval?.civilStartTime?.date));
    if (!row) continue;
    const grams = (key: string) => num((n.nutrients ?? []).find((x: Obj) => x.nutrient === key)?.quantity?.grams) ?? 0;
    row.sugar_g = r1((row.sugar_g ?? 0) + grams("SUGAR"));
    row.sat_fat_g = r1((row.sat_fat_g ?? 0) + grams("SATURATED_FAT"));
    row.oatmeal = (row.oatmeal ?? false) || isOatmeal(String(n.foodDisplayName ?? ""));
  }
  for (const p of raw.weight.flatMap((r) => points(r, "rollupDataPoints"))) {
    const row = at(civil(p.civilStartTime?.date));
    const g = num(p.weight?.weightGramsAvg);
    if (row && g !== null) row.weight_lb = r1(g / 453.59237);
  }
  for (const p of raw.bodyFat.flatMap((r) => points(r, "rollupDataPoints"))) {
    const row = at(civil(p.civilStartTime?.date));
    if (row) row.bf_pct = r1(num(p.bodyFat?.bodyFatPercentageAvg));
  }
  return [...rows.values()];
}

/** Raw fetch of one block (about 10–22 upstream requests with paging). */
async function fetchBlock(client: GoogleHealthClient, s: string, e: string) {
  const BY_DATE = { timeMember: "date" } as const;
  const SLEEP = { timeMember: "interval.end_time", physical: true } as const;
  {
    {
      const [hrv, rhr, sleep, exercise, azm, steps, nutrition, weight, bodyFat, foods] = await Promise.all([
        client.reconcile("daily-heart-rate-variability", s, e, BY_DATE),
        client.reconcile("daily-resting-heart-rate", s, e, BY_DATE),
        // Sleep is bucketed by wake time; widen by a day so a night that ends
        // just after a block boundary in UTC still lands in range.
        client.reconcile("sleep", s, nextDayIso(e), SLEEP),
        client.reconcile("exercise", s, e),
        client.dailyRollUp("active-zone-minutes", s, e),
        client.dailyRollUp("steps", s, e),
        client.dailyRollUp("nutrition-log", s, e),
        client.dailyRollUp("weight", s, e),
        client.dailyRollUp("body-fat", s, e),
        // Item-level food log: the only place sugar, saturated fat and food names appear.
        client.reconcile("nutrition-log", s, e),
      ]);
      return buildRows(s, e, {
        hrv: [hrv], rhr: [rhr], sleep: [sleep], exercise: [exercise], azm: [azm], steps: [steps],
        nutrition: [nutrition], weight: [weight], bodyFat: [bodyFat], foods: [foods],
      });
    }
  }
}

/** A block's rows are final (and stored for a year) once it ended at least
 *  this many days ago, which leaves room for late syncs such as a weigh-in. */
const SETTLE_DAYS = 7;
const BLOCK_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Rows for [start, end]. Settled blocks come from KV when stored. To stay under
 * the Workers per-invocation subrequest limit, at most one unstored settled
 * block is fetched per call (plus any unsettled, recent block); `pending` is
 * true when more remain, and the caller simply calls again.
 */
export async function fetchDailyRows(
  client: GoogleHealthClient,
  start: string,
  end: string,
  opts: { cache?: KVNamespace; userId?: string; today: string },
): Promise<{ rows: DailyRow[]; pending: boolean }> {
  const settledBefore = isoMinusDays(opts.today, SETTLE_DAYS);
  const rows: DailyRow[] = [];
  let fetchedSettled = 0;
  let pending = false;
  for (const [s, e] of blocks(start, end)) {
    const settled = e < settledBefore;
    const key = `v1:${opts.userId ?? "anon"}:daily4:${s}:${e}`;
    if (settled && opts.cache) {
      try {
        const hit = await opts.cache.get(key, "json");
        if (hit) { rows.push(...(hit as DailyRow[])); continue; }
      } catch { /* treat as miss */ }
    }
    if (settled && fetchedSettled >= 1) { pending = true; continue; }
    const blockRows = await fetchBlock(client, s, e);
    rows.push(...blockRows);
    if (settled) {
      fetchedSettled++;
      if (opts.cache) {
        try { await opts.cache.put(key, JSON.stringify(blockRows), { expirationTtl: BLOCK_TTL_SECONDS }); } catch { /* best effort */ }
      }
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, pending };
}

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
