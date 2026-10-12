import { afterEach, expect, it, vi } from "vitest";
import { configSchema } from "./balanceConfig";
import { probe } from "./balanceProbe";

const account = (extract = {}) => configSchema.parse({ providers: [{ provider: "p", baseUrl: "https://example.test", apiKey: "test-only", probe: { extract } }] }).providers[0];
afterEach(() => vi.unstubAllGlobals());

it("defaults total to the top-level field and preserves raw values and units", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ quota: { remaining: 222 }, total: 500, unit: "CNY" }))));
  expect(account().probe.extract.total).toBe("total");
  expect(await probe(account(), 1000)).toEqual({ balance: 222, total: 500, unit: "CNY" });
});

it("supports an explicit total path alongside existing extract paths", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ remaining: 2.22, total: 5, unit: "USD" }], total: 999 }))));
  const configured = account({ remaining: "data[0].remaining", total: "data[0].total", unit: "data[0].unit" });
  expect(await probe(configured, 1000)).toEqual({ balance: 2.22, total: 5, unit: "USD" });
});

it.each([undefined, null, 0, -1, "500", {}, Infinity, NaN])("keeps zero balance when total is unavailable or invalid: %s", async (total) => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ quota: { remaining: 0 }, total, unit: "USD" }) })));
  expect(await probe(account(), 1000)).toEqual({ balance: 0, total: null, unit: "USD" });
});

it.each(["http", "invalid", "network"])("returns consistent empty fields on %s failure", async (failure) => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (failure === "network") throw new Error("network");
    return new Response(JSON.stringify({ isValid: false, quota: { remaining: 222 }, total: 500, unit: "USD" }), { status: failure === "http" ? 500 : 200 });
  }));
  expect(await probe(account(), 1000)).toEqual({ balance: null, total: null, unit: null });
});
