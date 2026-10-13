import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PiBalance } from "../shared/balance";
const mocks = vi.hoisted(() => {
  // Query's interval scheduler uses browser detection; emulate the visible host.
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  return { rpc: vi.fn() };
});
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => mocks.rpc }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
import { createPillBalanceIcon } from "./pillBalanceIcon";
import { createPillBalanceDiagnostic, getPillBalanceDiagnostic } from "./pillBalanceDiagnostics";
const initial = { agentId: "a", provider: "pi", sessionId: "s1", model: "m1" };
const props = { context: "agent", agentId: "a", size: 16, color: "red" } as PluginButtonIconProps;
let root: ReactTestRenderer;
let client: QueryClient;
let diagnostic: ReturnType<typeof createPillBalanceDiagnostic>;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.rpc.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  diagnostic = createPillBalanceDiagnostic("a");
});
afterEach(() => {
  act(() => { root?.unmount(); });
  client.clear(); diagnostic.dispose(); vi.useRealTimers();
});
async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}
async function mount(bridge: ReturnType<typeof createPillBalanceIcon>, count = 1) {
  await act(async () => {
    root = create(<QueryClientProvider client={client}>{Array.from({ length: count }, (_, index) => <bridge.Icon key={index} {...props} />)}</QueryClientProvider>);
  });
  await flush();
}

test("Icon starts hook RPC without a popover, publishes loading then balance, and draws SDK Gauge", async () => {
  let finish!: (value: PiBalance) => void;
  mocks.rpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const publish = vi.fn();
  const bridge = createPillBalanceIcon(initial, publish, diagnostic);
  await mount(bridge);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith({ agent: "a", refresh: false });
  expect(publish).toHaveBeenLastCalledWith(null, "pending");
  expect(root.root.findByType("Icon" as never).props).toMatchObject({ name: "Gauge", size: 16, color: "red" });
  finish({ balance: 222, unit: "CNY" }); await flush();
  expect(publish).toHaveBeenLastCalledWith({ balance: 222, unit: "CNY" }, "success");
});

test("stable Icon presentation renders do not remount or request again; multiple observers deduplicate", async () => {
  mocks.rpc.mockResolvedValue({ balance: 222, unit: "CNY" });
  const bridge = createPillBalanceIcon(initial, vi.fn(), diagnostic);
  const Icon = bridge.Icon;
  await mount(bridge, 2);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(getPillBalanceDiagnostic("a")?.mounted).toBe(2);
  await act(async () => {
    root.update(<QueryClientProvider client={client}><Icon key={0} {...props} color="blue" /><Icon key={1} {...props} /></QueryClientProvider>);
  });
  await flush();
  expect(bridge.Icon).toBe(Icon);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(getPillBalanceDiagnostic("a")?.mounted).toBe(2);
  await flush(15_000);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

test("separate registrations with the same identity share the Query request", async () => {
  mocks.rpc.mockImplementation(() => new Promise(() => {}));
  const otherDiagnostic = createPillBalanceDiagnostic("other");
  const a = createPillBalanceIcon(initial, vi.fn(), diagnostic);
  const b = createPillBalanceIcon(initial, vi.fn(), otherDiagnostic);
  await act(async () => {
    root = create(<QueryClientProvider client={client}><a.Icon {...props} /><b.Icon {...props} /></QueryClientProvider>);
  });
  await flush();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  await act(async () => { a.dispose(); });
  expect(getPillBalanceDiagnostic("other")?.mounted).toBe(1);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  await act(async () => { b.dispose(); });
  otherDiagnostic.dispose();
});

test("disposed registration cannot supply its pending RPC to a replacement while its Icon stays mounted", async () => {
  const finishes: Array<(value: PiBalance) => void> = [];
  mocks.rpc.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const oldPublish = vi.fn();
  const a = createPillBalanceIcon(initial, oldPublish, diagnostic);
  await act(async () => {
    root = create(<QueryClientProvider client={client}><a.Icon key={0} {...props} /></QueryClientProvider>);
  });
  await flush();
  const oldIcon = root.root.findByType(a.Icon);
  await act(async () => { a.dispose(); });
  oldPublish.mockClear();

  const otherDiagnostic = createPillBalanceDiagnostic("replacement");
  try {
    const publish = vi.fn();
    const b = createPillBalanceIcon(initial, publish, otherDiagnostic);
    await act(async () => {
      root.update(<QueryClientProvider client={client}><a.Icon key={0} {...props} /><b.Icon key={1} {...props} /></QueryClientProvider>);
    });
    await flush();
    expect(root.root.findAllByType("Icon" as never)).toHaveLength(2);
    expect(root.root.findByType(a.Icon)).toBe(oldIcon);
    expect.soft(mocks.rpc).toHaveBeenCalledTimes(2);
    finishes[0]({ balance: 999, unit: "USD" });
    await flush();
    expect(publish).not.toHaveBeenCalledWith({ balance: 999, unit: "USD" }, "success");
    expect(oldPublish).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    finishes[1]({ balance: 100, unit: "CNY" });
    await flush();
    expect(publish).toHaveBeenLastCalledWith({ balance: 100, unit: "CNY" }, "success");
    await act(async () => { b.dispose(); });
  } finally {
    otherDiagnostic.dispose();
  }
});

test("successive replacements fetch fresh once per registration with multiple Icons and retained disposed Icons", async () => {
  const finishes: Array<(value: PiBalance) => void> = [];
  mocks.rpc.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const diagnostics = [diagnostic, createPillBalanceDiagnostic("replacement-1"), createPillBalanceDiagnostic("replacement-2")];
  const publications = diagnostics.map(() => vi.fn());
  const bridges: Array<ReturnType<typeof createPillBalanceIcon>> = [];
  try {
    for (let index = 0; index < diagnostics.length; index++) {
      if (index > 0) {
        await act(async () => { bridges[index - 1].dispose(); bridges[index - 1].dispose(); });
        publications[index - 1].mockClear();
      }
      bridges.push(createPillBalanceIcon(initial, publications[index], diagnostics[index]));
      const icons = bridges.flatMap((bridge, registration) => [0, 1].map(observer =>
        <bridge.Icon key={`${registration}-${observer}`} {...props} />));
      await act(async () => {
        if (index === 0) root = create(<QueryClientProvider client={client}>{icons}</QueryClientProvider>);
        else root.update(<QueryClientProvider client={client}>{icons}</QueryClientProvider>);
      });
      await flush();
      expect(root.root.findAllByType("Icon" as never)).toHaveLength((index + 1) * 2);
      expect(mocks.rpc).toHaveBeenCalledTimes(index + 1);
      expect(publications[index]).toHaveBeenLastCalledWith(null, "pending");
    }
    finishes[0]({ balance: 999, unit: "USD" });
    finishes[1]({ balance: 998, unit: "USD" });
    await flush();
    expect(publications[0]).not.toHaveBeenCalled();
    expect(publications[1]).not.toHaveBeenCalled();
    expect(publications[2]).toHaveBeenLastCalledWith(null, "pending");
    finishes[2]({ balance: 100, unit: "CNY" });
    await flush();
    expect(publications[2]).toHaveBeenLastCalledWith({ balance: 100, unit: "CNY" }, "success");
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => { for (const bridge of bridges) bridge.dispose(); });
    for (const entry of diagnostics.slice(1)) entry.dispose();
  }
});

test.each(["sessionId", "model", "provider", "agentId"] as const)("%s change isolates late RPC and returning identity fetches fresh", async field => {
  const finishes: Array<(value: PiBalance) => void> = [];
  mocks.rpc.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const publish = vi.fn();
  const bridge = createPillBalanceIcon(initial, publish, diagnostic);
  await mount(bridge);
  await act(async () => {
    bridge.setIdentity({ ...initial, [field]: "changed" });
    if (field === "agentId") root.update(<QueryClientProvider client={client}><bridge.Icon {...props} agentId="changed" context="agent" /></QueryClientProvider>);
  });
  await flush();
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  finishes[0]({ balance: 999, unit: "USD" }); await flush();
  expect(publish).not.toHaveBeenCalledWith({ balance: 999, unit: "USD" }, "success");
  finishes[1]({ balance: 100, unit: "CNY" }); await flush();
  expect(publish).toHaveBeenLastCalledWith({ balance: 100, unit: "CNY" }, "success");
  await act(async () => {
    bridge.setIdentity(initial);
    if (field === "agentId") root.update(<QueryClientProvider client={client}><bridge.Icon {...props} /></QueryClientProvider>);
  });
  await flush();
  expect(mocks.rpc).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenLastCalledWith(null, "pending");
});

test("refetch failure hides cached balance and next interval recovers; unknown and zero are deterministic", async () => {
  const publish = vi.fn();
  mocks.rpc.mockResolvedValue({ balance: 0, unit: "USD" });
  await mount(createPillBalanceIcon(initial, publish, diagnostic));
  expect(publish).toHaveBeenLastCalledWith({ balance: 0, unit: "USD" }, "success");
  mocks.rpc.mockRejectedValueOnce(new Error("private credential"));
  await flush(15_000);
  expect(publish).toHaveBeenCalledWith(null, "error");
  mocks.rpc.mockResolvedValue({ balance: null, unit: null });
  await flush(15_000);
  expect(publish).toHaveBeenLastCalledWith({ balance: null, unit: null }, "empty");
});

test.each(["unmount", "dispose"])("%s cancels observation and prevents late publication or background polling", async action => {
  let finish!: (value: PiBalance) => void;
  mocks.rpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const publish = vi.fn();
  const bridge = createPillBalanceIcon(initial, publish, diagnostic);
  await mount(bridge);
  await act(async () => { if (action === "unmount") root.unmount(); else bridge.dispose(); });
  publish.mockClear();
  finish({ balance: 999, unit: "USD" });
  await flush(30_000);
  expect(publish).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(getPillBalanceDiagnostic("a")?.mounted).toBe(0);
  client.clear();
  expect(vi.getTimerCount()).toBe(0);
});
