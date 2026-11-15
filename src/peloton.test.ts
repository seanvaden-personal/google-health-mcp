import { describe, it, expect } from "vitest";
import { PelotonClient, buildRide, dailyTotals, parseWorkout, powerZone, powerZoneMinutes } from "./peloton";

/** Minimal in-memory KV with the bits the client uses. */
function memKv() {
  const m = new Map<string, string>();
  return {
    m,
    kv: {
      get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null),
      put: async (k: string, v: string) => { m.set(k, v); },
      delete: async (k: string) => { m.delete(k); },
    } as unknown as KVNamespace,
  };
}

// 2026-11-14 12:00 local (America/New_York = UTC-5) → 17:00Z
const START = Date.UTC(2026, 10, 14, 17, 0, 0) / 1000;
const workout = (id: string, start: number, extra: Record<string, unknown> = {}) => ({
  id, created_at: start, start_time: start, end_time: start + 2700, status: "COMPLETE", fitness_discipline: "cycling",
  timezone: "America/New_York", total_work: 324000,
  ride: { title: "45 min Low Impact Ride", duration: 2700, instructor: { name: "Denis Morton" } }, ...extra,
});
const graph = {
  duration: 2700,
  summaries: [
    { slug: "total_output", value: 324, display_unit: "kj" },
    { slug: "distance", value: 13.2, display_unit: "mi" },
    { slug: "calories", value: 410 },
  ],
  average_summaries: [{ slug: "avg_output", value: 120 }, { slug: "avg_cadence", value: 82 }, { slug: "avg_resistance", value: 38 }, { slug: "avg_speed", value: 17.6 }],
  metrics: [
    { slug: "output", average_value: 120, max_value: 210, values: [100, 120, 160, 210] },
    { slug: "cadence", average_value: 82, max_value: 101 },
    { slug: "resistance", average_value: 38, max_value: 50 },
    { slug: "speed", average_value: 17.6, max_value: 21 },
  ],
};

describe("peloton parsing", () => {
  it("parses a list item with local date/time", () => {
    const w = parseWorkout(workout("a1", START), "America/New_York")!;
    expect(w).toMatchObject({ id: "a1", date: "2026-11-14", start: "12:00", duration_min: 45, total_output_kj: 324, instructor: "Denis Morton", ftp_w: null });
  });
  it("buckets a late-evening ride on the local date, not UTC", () => {
    const late = Date.UTC(2026, 10, 15, 2, 30) / 1000; // 21:30 local on the 14th
    expect(parseWorkout(workout("a2", late), "America/New_York")!.date).toBe("2026-11-14");
  });
  it("flags outdoor rides from the Peloton app", () => {
    const w = parseWorkout(workout("o1", START, { ride: { title: "20 min 17 sec Outdoor Cycling", instructor: { name: "20 MIN 17 SEC OUTDOOR CYCLING" } }, total_work: 0 }), "UTC")!;
    expect(w.outdoor).toBe(true);
    expect(parseWorkout(workout("a1", START), "UTC")!.outdoor).toBe(false);
  });
  it("maps power zones by % FTP", () => {
    expect([50, 60, 80, 100, 110, 140, 160].map((w) => powerZone(w, 100))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(powerZoneMinutes([50, 50, 100, 160, null], 100, 30)).toEqual({ z1: 1, z2: 0, z3: 0, z4: 0.5, z5: 0, z6: 0, z7: 0.5 });
  });
  it("builds a ride without FTP or HR", () => {
    const r = buildRide(parseWorkout(workout("a1", START), "America/New_York")!, graph, { ftp: null, source: null });
    expect(r).toMatchObject({ total_output_kj: 324, avg_power_w: 120, max_power_w: 210, avg_cadence_rpm: 82, avg_resistance_pct: 38, distance: 13.2, distance_unit: "mi", peloton_kcal: 410, avg_hr: null, hr_zone_min: null, power_zone_min: null });
  });
  it("builds power and HR zones when available", () => {
    const g = { ...graph, metrics: [...graph.metrics, { slug: "heart_rate", average_value: 122, max_value: 141, zones: [{ slug: "zone1", duration: 600 }, { slug: "zone2", duration: 2100 }] }] };
    const r = buildRide(parseWorkout(workout("a1", START), "America/New_York")!, g, { ftp: 150, source: "ftp_workout_source" }, 5);
    expect(r.avg_hr).toBe(122);
    expect(r.hr_zone_min).toEqual({ z1: 10, z2: 35 });
    expect(r.ftp_w).toBe(150);
    expect(r.power_zone_min!.z2).toBeGreaterThan(0);
  });
  it("totals per day", () => {
    const ws = [parseWorkout(workout("a1", START), "UTC")!, parseWorkout(workout("a2", START + 7200, { total_work: 108000 }), "UTC")!];
    expect(dailyTotals(ws).get("2026-11-14")).toEqual({ peloton_kj: 432, peloton_min: 90, peloton_avg_w: 80 });
  });
});

describe("PelotonClient", () => {
  function api(opts: { badToken?: boolean } = {}) {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(u.pathname);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (opts.badToken || auth !== "Bearer tok") return json({}, 401);
      if (u.pathname === "/api/me") return json({ id: "u1", cycling_ftp: 0, estimated_cycling_ftp: 160 });
      if (u.pathname === "/api/user/u1/workouts") {
        const page = Number(u.searchParams.get("page"));
        if (page === 0) return json({ data: [workout("w3", START + 86400), workout("w2", START), workout("s1", START - 3600, { fitness_discipline: "strength" })], show_next: true });
        return json({ data: [workout("w1", START - 5 * 86400)], show_next: false });
      }
      if (u.pathname.startsWith("/api/workout/")) return json(graph);
      return json({}, 404);
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const now = () => (START + 3 * 86400) * 1000;
  const mk = (f: typeof fetch, kv?: KVNamespace, token = "tok") =>
    new PelotonClient({ token, cache: kv, userId: "sean", timeZone: "America/New_York", fetchImpl: f, now });

  it("uses the bearer token, pages back to the start date, caches settled rides", async () => {
    const { f, calls } = api();
    const { kv, m } = memKv();
    const out = await mk(f, kv).rides("2026-11-14", "2026-11-15");
    expect(out.pending).toBe(false);
    expect(out.rides.map((r) => r.id)).toEqual(["w2", "w3"]);
    expect(out.rides[0]).toMatchObject({ ftp_w: 160, ftp_source: "estimated" });
    expect(calls.filter((x) => x === "/api/me")).toHaveLength(1);
    expect(m.get("v1:sean:peloton1:user")).toBe("u1");
    expect(m.has("v1:sean:peloton1:ride:w2")).toBe(true);

    // A new tool call: user id and rides come from KV.
    const again = api();
    await mk(again.f, kv).rides("2026-11-14", "2026-11-15");
    expect(again.calls.some((x) => x === "/api/me" || x.includes("performance"))).toBe(false);
  });

  it("accepts a token pasted with the 'Bearer ' prefix", async () => {
    const { f } = api();
    expect((await mk(f, undefined, "Bearer tok ").listWorkouts("2026-11-14", "2026-11-15")).length).toBeGreaterThan(0);
  });

  it("explains an expired token without echoing it", async () => {
    const { f } = api({ badToken: true });
    const p = mk(f, undefined, "secret-token").listWorkouts("2026-11-14", "2026-11-15");
    await expect(p).rejects.toThrow(/rejected the bearer token \(HTTP 401\).*PELOTON_BEARER_TOKEN/);
    await expect(mk(f, undefined, "secret-token").listWorkouts("2026-11-14", "2026-11-15")).rejects.not.toThrow(/secret-token/);
  });
});
