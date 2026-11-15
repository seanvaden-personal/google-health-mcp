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
  function api(opts: { expireFirst?: boolean } = {}) {
    const calls: string[] = [];
    let expired = !!opts.expireFirst;
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (u.pathname === "/auth/login") {
        const body = JSON.parse(String(init?.body));
        if (body.password !== "pw") return json({ message: "bad" }, 401);
        return json({ session_id: "sess", user_id: "u1" });
      }
      if (expired) { expired = false; return json({}, 401); }
      const cookie = (init?.headers as Record<string, string>)?.Cookie;
      if (cookie !== "peloton_session_id=sess") return json({}, 401);
      if (u.pathname === "/api/user/u1/workouts") {
        const page = Number(u.searchParams.get("page"));
        if (page === 0) return json({ data: [workout("w3", START + 86400), workout("w2", START), workout("s1", START - 3600, { fitness_discipline: "strength" })], show_next: true });
        return json({ data: [workout("w1", START - 5 * 86400)], show_next: false });
      }
      if (u.pathname.startsWith("/api/workout/")) return json(graph);
      if (u.pathname === "/api/me") return json({ cycling_ftp: 0, estimated_cycling_ftp: 160 });
      return json({}, 404);
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const now = () => (START + 3 * 86400) * 1000;

  it("logs in once, pages back to the start date, caches settled rides", async () => {
    const { f, calls } = api();
    const { kv, m } = memKv();
    const c = new PelotonClient({ username: "me", password: "pw", cache: kv, userId: "sean", timeZone: "America/New_York", fetchImpl: f, now });
    const out = await c.rides("2026-11-14", "2026-11-15");
    expect(out.pending).toBe(false);
    expect(out.rides.map((r) => r.id)).toEqual(["w2", "w3"]);
    expect(out.rides[0]).toMatchObject({ ftp_w: 160, ftp_source: "estimated" });
    expect(calls.filter((x) => x.includes("/auth/login"))).toHaveLength(1);
    expect(m.has("v1:sean:peloton1:ride:w2")).toBe(true);

    // Second client (new tool call): session and rides come from KV.
    const again = api();
    const c2 = new PelotonClient({ username: "me", password: "pw", cache: kv, userId: "sean", timeZone: "America/New_York", fetchImpl: again.f, now });
    await c2.rides("2026-11-14", "2026-11-15");
    expect(again.calls.some((x) => x.includes("/auth/login") || x.includes("performance"))).toBe(false);
  });

  it("re-logs in when the cached session has expired", async () => {
    const { f, calls } = api({ expireFirst: true });
    const { kv } = memKv();
    await kv.put("v1:sean:peloton1:session", JSON.stringify({ id: "sess", userId: "u1" }));
    const c = new PelotonClient({ username: "me", password: "pw", cache: kv, userId: "sean", timeZone: "UTC", fetchImpl: f, now });
    const ws = await c.listWorkouts("2026-11-14", "2026-11-15");
    expect(ws.length).toBeGreaterThan(0);
    expect(calls.filter((x) => x.includes("/auth/login"))).toHaveLength(1);
  });

  it("surfaces a login failure without leaking the password", async () => {
    const { f } = api();
    const c = new PelotonClient({ username: "me", password: "wrong-secret", userId: "sean", timeZone: "UTC", fetchImpl: f, now });
    await expect(c.listWorkouts("2026-11-14", "2026-11-15")).rejects.toThrow(/Peloton login failed: HTTP 401/);
    await expect(c.listWorkouts("2026-11-14", "2026-11-15")).rejects.not.toThrow(/wrong-secret/);
  });
});
