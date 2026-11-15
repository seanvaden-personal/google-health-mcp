import { describe, it, expect, vi, afterEach } from "vitest";
import { GoogleHealthClient } from "./google-health";

afterEach(() => vi.unstubAllGlobals());

describe("GoogleHealthClient token refresh", () => {
  it("refreshes once when many parallel requests hit an expired token", async () => {
    let refreshes = 0;
    let apiCalls = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
      }
      apiCalls++;
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth !== "Bearer new") return new Response("expired", { status: 401 });
      return new Response(JSON.stringify({ rollupDataPoints: [] }), { status: 200 });
    });
    const c = new GoogleHealthClient({ accessToken: "old", refreshToken: "r", clientId: "id", clientSecret: "s", timeZone: "UTC" });
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.dailyRollUp(`type-${i}`, "2099-01-01", "2099-01-02")));
    expect(refreshes).toBe(1);
    expect(apiCalls).toBe(20); // 10 rejected + 10 retried
  });
});
