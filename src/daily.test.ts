import { describe, it, expect } from "vitest";
import { blocks, buildRows, localDate } from "./daily";

describe("daily", () => {
  it("splits into aligned two-month blocks", () => {
    expect(blocks("2026-05-01", "2026-11-14")).toEqual([
      ["2026-05-01", "2026-06-30"], ["2026-07-01", "2026-08-31"], ["2026-09-01", "2026-10-31"], ["2026-11-01", "2026-11-14"],
    ]);
    expect(blocks("2026-06-10", "2026-06-12")).toEqual([["2026-06-10", "2026-06-12"]]);
  });
  it("uses local wake date", () => {
    expect(localDate("2026-11-13T03:50:00Z", "-18000s")).toBe("2026-11-12");
  });
  it("merges and dedupes", () => {
    const night = { dataPointName: "n1", sleep: { interval: { endTime: "2026-11-13T13:50:00Z", endUtcOffset: "-18000s" }, metadata: { mainSleep: true }, summary: { minutesAsleep: "387", stagesSummary: [{ type: "DEEP", minutes: "73" }, { type: "REM", minutes: "119" }] } } };
    const skate = { dataPointName: "e1", exercise: { interval: { startTime: "2026-11-10T18:04:43Z", startUtcOffset: "-18000s", endTime: "2026-11-10T19:33:30Z" }, exerciseType: "SKATEBOARDING", activeDuration: "5327.050s" } };
    const rows = buildRows("2026-11-10", "2026-11-13", {
      hrv: [{ dataPoints: [{ dailyHeartRateVariability: { date: { year: 2026, month: 11, day: 13 }, averageHeartRateVariabilityMilliseconds: 29.04 } }] }],
      rhr: [], sleep: [{ dataPoints: [night] }, { dataPoints: [night] }], exercise: [{ dataPoints: [skate, { dataPointName: "e2", exercise: { interval: { startTime: "2026-11-10T18:05:00Z", startUtcOffset: "-18000s", endTime: "2026-11-10T19:30:00Z" }, exerciseType: "OTHER", activeDuration: "5100s" } }] }],
      azm: [], steps: [{ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 11, day: 12 } }, steps: { countSum: "7993" } }] }],
      nutrition: [{ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 11, day: 13 } }, nutritionLog: { nutrients: [{ quantity: { gramsSum: 127.78 }, nutrient: "PROTEIN" }], energy: { kcalSum: 1562.875 }, totalCarbohydrate: { gramsSum: 129.6 }, totalFat: { gramsSum: 60.3 } } }] }],
      weight: [{ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 11, day: 10 } }, weight: { weightGramsAvg: 88099 } }] }],
      bodyFat: [],
    });
    expect(rows).toHaveLength(4);
    const by = Object.fromEntries(rows.map((r) => [r.date, r]));
    expect(by["2026-11-13"].sleep_h).toBe(6.5);
    expect(by["2026-11-13"].deep_min).toBe(73);
    expect(by["2026-11-13"].hrv_ms).toBe(29);
    expect(by["2026-11-10"].skate_min).toBe(89);
    expect(by["2026-11-10"].other_min).toBe(0);
    expect(by["2026-11-10"].weight_lb).toBe(194.2);
    expect(by["2026-11-12"].steps).toBe(7993);
    expect(by["2026-11-13"].kcal_in).toBe(1563);
    expect(by["2026-11-13"].protein_g).toBe(127.8);
  });
});
