import type { PaseoApi } from "@getpaseo/client";
import { afterEach, expect, it, vi } from "vitest";
import { BalanceService } from "./balanceService";
import { configSchema } from "./balanceConfig";

const config = configSchema.parse({ providers: [{ provider: "p", baseUrl: "https://example.test", apiKey: "test-only" }] });
const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { provider: "pi", model: "p/m", persistence: { sessionId: "s" } } }) }) } } as unknown as PaseoApi;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("deduplicates, caches for 15 seconds, and refresh bypasses cache", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ quota: { remaining: 0 }, unit: "USD", total: 500 })));
  vi.stubGlobal("fetch", fetchMock);
  const service = new BalanceService(Promise.resolve(config));
  expect(await Promise.all([service.snapshot("a", paseo), service.snapshot("a", paseo)])).toEqual([{ balance: 0, unit: "USD", total: 500 }, { balance: 0, unit: "USD", total: 500 }]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await service.snapshot("a", paseo);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await service.snapshot("a", paseo, true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15001);
  await service.snapshot("a", paseo);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  service.dispose();
});
it("hides missing configuration and failed probes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
  expect(await new BalanceService(Promise.reject(new Error("missing"))).snapshot("a", paseo)).toEqual({ balance: null, unit: null, total: null });
  expect(await new BalanceService(Promise.resolve(config)).snapshot("a", paseo)).toEqual({ balance: null, unit: null, total: null });
});
it("suppresses pending responses after clear and dispose", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const service = new BalanceService(Promise.resolve(config));
  const pending = service.snapshot("a", paseo);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  service.clear("a");
  finish(new Response(JSON.stringify({ quota: { remaining: 10 }, unit: "USD" })));
  expect(await pending).toEqual({ balance: null, unit: null, total: null });
  service.dispose();
  expect(await service.snapshot("a", paseo)).toEqual({ balance: null, unit: null, total: null });
});
