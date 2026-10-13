import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piBalanceRpc, type PiBalance } from "../shared/balance";
import { piUsageSnapshotRpc, type UsageSnapshot } from "../shared/usage";
import { startUsagePills } from "./pills";
import { getPillBalanceDiagnostic } from "./pillBalanceDiagnostics";

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => iconRpc,
  useAgent: vi.fn(),
}));

vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
let iconRpc: (...args: unknown[]) => unknown;
const mounted: ReactTestRenderer[] = [];
const queries: QueryClient[] = [];

const dimensions = vi.hoisted(() => ({
  width: 800,
  listener: null as ((event: { window: { width: number } }) => void) | null,
  remove: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Button",
  ScrollView: "ScrollView",
  Dimensions: {
    get: vi.fn(() => ({ width: dimensions.width })),
    addEventListener: vi.fn((_: string, listener: (event: { window: { width: number } }) => void) => {
      dimensions.listener = listener;
      return { remove: dimensions.remove };
    }),
  },
}));

interface FakePill extends PluginButtonRegistration {
  agentId: string;
  label: string;
  title: string;
  removed: boolean;
  presses: number;
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-11T09:00:00.000Z");

function agent(overrides: Partial<Record<string, unknown>> & { id: string }) {
  return {
    provider: "pi",
    model: "aliyun/qwen3.8-max",
    persistence: { provider: "pi", sessionId: "s1" },
    workspaceId: "wks_1",
    status: "idle",
    cwd: "/repo/app",
    archivedAt: null,
    lastUserMessageAt: new Date(NOW - 10 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 10 * HOUR).toISOString(),
    createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    ...overrides,
  };
}

function snapshotFor(agentId: string, totalTokens: number): UsageSnapshot {
  return {
    agentId,
    status: "ok" as const,
    error: null,
    provider: "pi",
    model: "aliyun/qwen3.8-max",
    thinkingLevel: null,
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    totals: { input: 12_300, output: 4500, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
    totalTokens,
    calls: 3,
    userTurns: 1,
    compactions: 0,
    contextUsedTokens: 42_000,
    contextWindowTokens: 100_000,
    contextPercent: 42,
    contextStale: false,
    cacheHitRate: null,
    startedAt: null,
    lastActivityAt: null,
    fileBytes: 10,
  };
}

function harness(agents: Array<Record<string, unknown>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queries.push(queryClient);
  const pills = new Map<string, FakePill>();
  const polled: string[][] = [];
  const listeners: Array<(update: unknown) => void> = [];

  const addComposerPill = vi.fn((contribution: { agentId: string; button: { title: string; label?: string; icon: React.ComponentType<PluginButtonIconProps> } }) => {
    let iconRoot: ReactTestRenderer | null = null;
    const iconElement = () => React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(contribution.button.icon, { context: "agent", agentId: contribution.agentId, size: 16, color: "black" } as PluginButtonIconProps));
    const pill: FakePill = {
      agentId: contribution.agentId,
      title: contribution.button.title,
      label: contribution.button.label ?? "",
      removed: false,
      presses: 0,
      update(patch: { label?: string; title?: string }) {
        if (patch.label !== undefined) this.label = patch.label;
        if (patch.title !== undefined) this.title = patch.title;
        iconRoot?.update(iconElement());
      },
      remove() {
        this.removed = true;
        iconRoot?.unmount();
        pills.delete(this.agentId);
      },
    };
    pills.set(contribution.agentId, pill);
    // Host mounts Icon after registration; balance starts without opening the popover.
    Promise.resolve().then(() => {
      if (pill.removed) return;
      iconRoot = create(iconElement());
      mounted.push(iconRoot);
    });
    return pill;
  });

  const balanceRpc = vi.fn(async (): Promise<PiBalance> => ({ balance: null, unit: null }));
  iconRpc = balanceRpc;
  const snapshotRpc = vi.fn(async (input: { agentIds: string[] }) => ({
    readAt: new Date(NOW).toISOString(),
    agents: input.agentIds.map((id, index) => snapshotFor(id, 1000 + index)),
  }));
  const rpc = vi.fn(async (_contract: unknown, input: { agentIds: string[] }) => {
    if (_contract === piBalanceRpc) return balanceRpc();
    polled.push([...input.agentIds]);
    return snapshotRpc(input);
  });

  const list = vi.fn(async () => ({
    requestId: "r1",
    entries: agents.map((entry) => ({ agent: entry, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
  }));

  const subscribe = vi.fn((handler: (update: unknown) => void) => {
    listeners.push(handler);
    return () => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
  });

  const client = {
    addComposerPill,
    rpc,
    paseo: { agents: { list, subscribe } },
  } as unknown as PluginClientContext;

  return {
    client,
    pills,
    polled,
    list,
    rpc,
    balanceRpc,
    snapshotRpc,
    addComposerPill,
    emit(update: unknown) {
      for (const listener of [...listeners]) listener(update);
    },
  };
}

function suspendWatchdogTimeouts() {
  const callbacks: Array<() => void> = [];
  const schedule = globalThis.setTimeout;
  const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === 12_000) {
      callbacks.push(callback);
      return schedule(() => {}, delay);
    }
    return schedule(callback, delay);
  }) as typeof setTimeout);
  return { callbacks, restore: () => timeout.mockRestore() };
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe("startUsagePills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dimensions.width = 800;
    dimensions.listener = null;
    dimensions.remove.mockClear();
  });

  afterEach(() => {
    act(() => { for (const root of mounted.splice(0)) root.unmount(); });
    for (const query of queries.splice(0)) query.clear();
    vi.useRealTimers();
  });

  it("pills only Pi agents that belong to a workspace", async () => {
    const context = harness([
      agent({ id: "pi-1" }),
      agent({ id: "codex-1", provider: "codex" }),
      agent({ id: "pi-detached", workspaceId: null }),
      agent({ id: "pi-archived", archivedAt: new Date(NOW).toISOString() }),
    ]);

    const stop = startUsagePills(context.client);
    await advance(0);

    expect([...context.pills.keys()]).toEqual(["pi-1"]);
    expect(context.pills.get("pi-1")?.title).toBe("Pi token 用量 · ↑12k ↓4.5k 缓存命中 0.0% 上下文 42%");

    stop();
  });

  it("labels the pill from the snapshot and keeps polling only active agents", async () => {
    const context = harness([
      agent({ id: "hot", status: "running", updatedAt: new Date(NOW).toISOString() }),
      agent({ id: "cold" }),
    ]);

    const stop = startUsagePills(context.client);
    await advance(0);

    // Bootstrap polls every tracked agent once, newest first from the batch result.
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);
    expect(context.pills.get("hot")?.label).toBe("— 42%");
    expect(context.pills.get("cold")?.label).toBe("— 42%");

    context.polled.length = 0;
    await advance(2500);
    expect(context.polled).toEqual([["hot"]]);

    // A status change makes a quiet agent worth one more read.
    context.polled.length = 0;
    context.emit({ kind: "upsert", agent: agent({ id: "cold", status: "running", updatedAt: new Date(NOW).toISOString() }) });
    await advance(2500);
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);

    stop();
  });

  it("drops the pill when the agent goes away", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.has("pi-1")).toBe(true);

    context.emit({ kind: "remove", agentId: "pi-1" });
    expect(context.pills.has("pi-1")).toBe(false);

    context.emit({ kind: "upsert", agent: agent({ id: "pi-2" }) });
    expect(context.pills.has("pi-2")).toBe(true);
    context.emit({ kind: "upsert", agent: agent({ id: "pi-2", archivedAt: new Date(NOW).toISOString() }) });
    expect(context.pills.has("pi-2")).toBe(false);

    stop();
  });

  it.each([
    [599, "—", "¥222.00"],
    [600, "— ?%", "¥222.00 33%"],
  ])("uses the initial %spx window width before any snapshot", async (width, initialLabel, label) => {
    dimensions.width = width;
    const context = harness([]);
    context.balanceRpc.mockResolvedValue({ balance: 222, unit: "RMB" });
    context.snapshotRpc.mockResolvedValue({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000), contextPercent: 33 }],
    });
    const stop = startUsagePills(context.client);
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1" }) });
    expect(context.pills.get("pi-1")?.label).toBe(initialLabel);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe(label);
    const contribution = context.addComposerPill.mock.calls[0][0] as unknown as {
      button: { icon: string; label: string; behavior: { kind: string; Content: unknown } };
    };
    expect(contribution.button.label).toBe(initialLabel);
    expect(typeof contribution.button.icon).toBe("function");
    expect(contribution.button.behavior.kind).toBe("popover");
    expect(typeof contribution.button.behavior.Content).toBe("function");
    stop();
  });

  it.each([599, 600])("mounts Icon at %spx and loads balance while usage and popover are absent", async width => {
    dimensions.width = width;
    const context = harness([agent({ id: "pi-1" })]);
    context.snapshotRpc.mockImplementation(() => new Promise(() => {}));
    let finish!: (value: PiBalance) => void;
    context.balanceRpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.balanceRpc).toHaveBeenCalledTimes(1);
    expect(context.rpc).not.toHaveBeenCalledWith(piBalanceRpc, expect.anything());
    const Icon = context.addComposerPill.mock.calls[0][0].button.icon;
    expect(context.pills.get("pi-1")?.label).toBe(width < 600 ? "—" : "— ?%");
    finish({ balance: 222, unit: "CNY" });
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe(width < 600 ? "¥222.00" : "¥222.00 ?%");
    expect(context.addComposerPill.mock.calls[0][0].button.icon).toBe(Icon);
    expect(context.balanceRpc).toHaveBeenCalledTimes(1);
    expect(getPillBalanceDiagnostic("pi-1")?.mounted).toBe(1);
    stop();
  });

  it("keeps an unknown balance placeholder without a model or usage snapshot", async () => {
    dimensions.width = 599;
    const context = harness([agent({ id: "pi-1", model: null, persistence: null })]);
    context.snapshotRpc.mockResolvedValue({ readAt: new Date(NOW).toISOString(), agents: [] });
    context.balanceRpc.mockResolvedValue({ balance: null, unit: null });
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.balanceRpc).toHaveBeenCalledWith({ agent: "pi-1", refresh: false });
    expect(context.pills.get("pi-1")?.label).toBe("—");
    expect(context.pills.get("pi-1")?.title).not.toContain("余额");
    stop();
  });

  it("immediately redraws all tracked pills across 599/600px without RPC and stops after cleanup", async () => {
    const context = harness([agent({ id: "pi-1" }), agent({ id: "pi-2" })]);
    context.balanceRpc.mockResolvedValue({ balance: 222, unit: "RMB" });
    const stop = startUsagePills(context.client);
    await advance(0);
    const pills = [...context.pills.values()];
    const titles = pills.map(pill => pill.title);
    const updates = pills.map(pill => vi.spyOn(pill, "update"));
    const rpcCalls = context.rpc.mock.calls.length;

    expect(dimensions.listener).not.toBeNull();
    dimensions.listener!({ window: { width: 599 } });
    expect(pills.map(pill => pill.label)).toEqual(["¥222.00", "¥222.00"]);
    expect(pills.map(pill => pill.title)).toEqual(titles);
    dimensions.listener!({ window: { width: 600 } });
    expect(pills.map(pill => pill.label)).toEqual(["¥222.00 42%", "¥222.00 42%"]);
    expect(pills.map(pill => pill.title)).toEqual(titles);
    expect(context.rpc).toHaveBeenCalledTimes(rpcCalls);

    stop();
    expect(dimensions.remove).toHaveBeenCalledTimes(1);
    updates.forEach(update => update.mockClear());
    dimensions.listener!({ window: { width: 599 } });
    expect(updates.every(update => update.mock.calls.length === 0)).toBe(true);
    expect(context.pills.size).toBe(0);
    expect(context.rpc).toHaveBeenCalledTimes(rpcCalls);
  });

  it.each([
    [{ balance: 0, unit: "RMB" }, "¥0.00"],
    [{ balance: 0, unit: "USD" }, "$0.00"],
    [{ balance: null, unit: "RMB" }, "—"],
    [{ balance: 222, unit: null }, "—"],
  ] as const)("preserves zero and unknown balances on compact screens: %s", async (balance, label) => {
    dimensions.width = 400;
    const context = harness([agent({ id: "pi-1" })]);
    context.balanceRpc.mockResolvedValue(balance);
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe(label);
    expect(context.pills.get("pi-1")?.title).toContain("上下文 42%");
    stop();
  });

  it("opens the token view as a pill popover", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await advance(0);

    const contribution = context.addComposerPill.mock.calls[0][0] as unknown as {
      button: { icon: string; label: string; behavior: { kind: string; Content: unknown } };
    };
    expect(typeof contribution.button.icon).toBe("function");
    expect(contribution.button.label).toBe("— ?%");
    expect(contribution.button.behavior.kind).toBe("popover");
    expect(typeof contribution.button.behavior.Content).toBe("function");

    stop();
  });

  it("keeps the previous label and stops polling after cleanup", async () => {
    const context = harness([agent({ id: "hot", status: "running", updatedAt: new Date(NOW).toISOString() })]);
    const stop = startUsagePills(context.client);
    await advance(0);
    const label = context.pills.get("hot")?.label;
    expect(label).toBe("— 42%");

    context.rpc.mockRejectedValueOnce(new Error("daemon gone"));
    context.polled.length = 0;
    await advance(2500);
    expect(context.pills.get("hot")?.label).toBe(label);

    stop();
    expect(context.pills.size).toBe(0);
    context.polled.length = 0;
    await advance(10_000);
    expect(context.polled).toEqual([]);
  });

  it.each([
    ["USD", 200, "$200.00"],
    ["RMB", 200, "¥200.00"],
    ["CNY", 200, "¥200.00"],
    ["USD", 0, "$0.00"],
    ["RMB", 0, "¥0.00"],
    ["CNY", 0, "¥0.00"],
    ["USD", 222.126, "$222.13"],
  ])("renders the actual %s balance label for %s", async (unit, balance, label) => {
    const context = harness([agent({ id: "pi-1" })]);
    context.balanceRpc.mockResolvedValue({ balance, unit });
    const stop = startUsagePills(context.client);
    await advance(0);

    expect(context.pills.get("pi-1")?.label).toBe(`${label} 42%`);
    expect(context.pills.get("pi-1")?.title).toContain(`余额 ${label.replace(/^¥/, "￥")}`);
    stop();
  });

  it.each([
    [77_000, 272_000, false, "ok"],
    [12_300, 100_000, false, "ok"],
    [0, 272_000, false, "ok"],
    [NaN, 272_000, false, "ok"],
    [Infinity, 272_000, false, "ok"],
    [-1, 272_000, false, "ok"],
    [77_000, null, false, "ok"],
    [77_000, NaN, false, "ok"],
    [77_000, Infinity, false, "ok"],
    [77_000, 272_000, true, "ok"],
    [77_000, 272_000, false, "error"],
    [77_000, 272_000, false, "no_session"],
  ] as const)("omits context capacity %s/%s from the label (stale %s, status %s)", async (used, window, stale, status) => {
    const context = harness([agent({ id: "pi-1" })]);
    context.balanceRpc.mockResolvedValue({ balance: 222, unit: "RMB" });
    context.snapshotRpc.mockResolvedValue({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000), contextUsedTokens: used, contextWindowTokens: window,
        contextPercent: 42, contextStale: stale, status,
        cacheHitRate: 99, totals: { ...snapshotFor("pi-1", 1000).totals, cacheRead: 100_000, cost: 1 } }],
    });
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe(`¥222.00 ${status === "ok" && !stale ? "42" : "?"}%`);
    if (status === "ok") {
      expect(context.pills.get("pi-1")?.title).toContain("↑12k ↓4.5k 缓存命中");
      expect(context.pills.get("pi-1")?.title).toContain("上下文 42%");
      expect(context.pills.get("pi-1")?.title).toContain("$1.000");
    }
    stop();
  });

  it.each([
    [33, false, "33"],
    [28, false, "28"],
    [0, false, "0.0"],
    [4.25, false, "4.3"],
    [42.4, false, "42"],
    [null, false, "?"],
    [NaN, false, "?"],
    [Infinity, false, "?"],
    [28, true, "?"],
  ] as const)("preserves context percent formatting for %s (stale %s)", async (percent, stale, expected) => {
    const context = harness([agent({ id: "pi-1" })]);
    context.balanceRpc.mockResolvedValue({ balance: 222, unit: "RMB" });
    context.snapshotRpc.mockResolvedValue({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000), contextUsedTokens: 111_000, contextWindowTokens: 333_000,
        contextPercent: percent, contextStale: stale }],
    });
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe(`¥222.00 ${expected}%`);
    stop();
  });

  it.each([
    { balance: null, unit: "USD" },
    { balance: 200, unit: null },
    { balance: 200, unit: " " },
    { balance: NaN, unit: "USD" },
    { balance: Infinity, unit: "USD" },
  ])("uses a placeholder for unavailable balance %s", async (balance) => {
    const context = harness([agent({ id: "pi-1" })]);
    context.balanceRpc.mockResolvedValue(balance);
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");
    expect(context.pills.get("pi-1")?.title).not.toContain("余额");
    stop();
  });

  it.each(["success", "failure"])("recovers snapshots through the deadline cancel race and ignores late %s and timeout", async (outcome) => {
    const watchdog = suspendWatchdogTimeouts();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const context = harness([agent({ id: "pi-1" })]);
    type SnapshotResult = Awaited<ReturnType<typeof context.snapshotRpc>>;
    let resolveOld!: (value: SnapshotResult) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: SnapshotResult) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(0);
      const oldTimeout = watchdog.callbacks[0];
      await advance(10_000);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(1);
      wallClock.mockReturnValue(NOW + 89_000);
      await advance(2500);
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      oldTimeout();
      if (outcome === "success") resolveOld({ readAt: "", agents: [{ ...snapshotFor("pi-1", 1000), contextPercent: 99 }] });
      else rejectOld(new Error("late failure"));
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(context.pills.get("pi-1")?.label).toBe("— ?%");
      resolveNew({ readAt: "", agents: [snapshotFor("pi-1", 1000)] });
      await advance(0);
      expect(context.pills.get("pi-1")?.label).toBe("— 42%");
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(getPillBalanceDiagnostic("pi-1")).toMatchObject({ state: "empty" });
    } finally {
      stop();
      error.mockRestore();
      wallClock.mockRestore();
      watchdog.restore();
    }
  });

  it("retries permanently pending snapshots after 12 seconds without resetting balances", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    context.snapshotRpc.mockImplementationOnce(() => new Promise(() => {}));
    context.balanceRpc.mockImplementationOnce(() => new Promise<PiBalance>(() => {}));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(11_999);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(1);
      await advance(501);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(context.balanceRpc).toHaveBeenCalledTimes(1);
      expect(context.pills.get("pi-1")?.label).toBe("— 42%");
      expect(getPillBalanceDiagnostic("pi-1")).toMatchObject({ state: "pending" });
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it.each(["success", "failure"])("ignores a timed-out snapshot's late %s while a new snapshot is pending", async (outcome) => {
    const context = harness([agent({ id: "pi-1" })]);
    type SnapshotResult = Awaited<ReturnType<typeof context.snapshotRpc>>;
    let resolveOld!: (value: SnapshotResult) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: SnapshotResult) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    }));
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(12_500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      if (outcome === "success") resolveOld({ readAt: "", agents: [{ ...snapshotFor("pi-1", 1000), contextPercent: 99 }] });
      else rejectOld(new Error("late failure"));
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(context.pills.get("pi-1")?.label).toBe("— ?%");
      resolveNew({ readAt: "", agents: [snapshotFor("pi-1", 1000)] });
      await advance(0);
      expect(context.pills.get("pi-1")?.label).toBe("— 42%");
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("keeps an idle agent dirty when its timed-out snapshot arrives before the retry tick", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    let resolveOld!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(12_000);
      resolveOld({ readAt: "", agents: [{ ...snapshotFor("pi-1", 1000), contextPercent: 99 }] });
      await advance(0);
      expect(context.pills.get("pi-1")?.label).toBe("— ?%");
      await advance(500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(context.pills.get("pi-1")?.label).toBe("— 42%");
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("preserves another agent's pending balance across a snapshot timeout and retry", async () => {
    dimensions.width = 599;
    const context = harness([agent({ id: "pi-1" })]);
    context.snapshotRpc.mockImplementationOnce(() => new Promise(() => {}));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(7500);
      let resolveBalance!: (value: PiBalance) => void;
      context.balanceRpc.mockImplementationOnce(() => new Promise(resolve => { resolveBalance = resolve; }));
      context.emit({ kind: "upsert", agent: agent({ id: "pi-2" }) });
      await advance(5000);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect(getPillBalanceDiagnostic("pi-2")).toMatchObject({ state: "pending" });
      resolveBalance({ balance: 222, unit: "RMB" });
      await advance(0);
      expect(context.pills.get("pi-2")?.label).toBe("¥222.00");
      expect(getPillBalanceDiagnostic("pi-2")).toMatchObject({ state: "success" });
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("clears a pending snapshot timer on cleanup and ignores its late response", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    let resolveSnapshot!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    const stop = startUsagePills(context.client);
    await advance(0);
    const pill = context.pills.get("pi-1")!;
    stop();
    resolveSnapshot({ readAt: "", agents: [snapshotFor("pi-1", 1000)] });
    await advance(0);
    expect(pill.label).toBe("— ?%");
  });

  it.each(["session", "model", "provider"])("rejects in-flight usage after idle %s changes and retries", async (identity) => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");

    let resolveOld!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", lastUserMessageAt: new Date(NOW - 9 * HOUR).toISOString() }) });
    await advance(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(2);

    const change = identity === "session"
      ? { persistence: { provider: "pi", sessionId: "s2" } }
      : identity === "model" ? { model: "new-model" } : { provider: "codex" };
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", ...change }) });
    if (identity === "provider") {
      context.emit({ kind: "upsert", agent: agent({ id: "pi-1" }) });
    }
    expect(context.pills.get("pi-1")?.label).toBe("— ?%");
    await advance(0);
    expect(context.pills.get("pi-1")?.label).toBe("— ?%");
    expect(context.pills.get("pi-1")?.title).not.toContain("上下文");
    expect(context.balanceRpc).toHaveBeenCalledTimes(2);

    let resolveNew!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    await advance(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    resolveOld({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000), contextUsedTokens: 99_000, contextPercent: 99 }],
    });
    await advance(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    expect(context.pills.get("pi-1")?.label).toBe("— ?%");
    resolveNew({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000),
        sessionId: identity === "session" ? "s2" : "s1",
        model: identity === "model" ? "new-model" : "aliyun/qwen3.8-max",
        contextUsedTokens: 77_000, contextWindowTokens: 272_000,
      }],
    });
    await advance(0);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");
    expect(context.balanceRpc).toHaveBeenCalledTimes(2);
    await advance(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    stop();
  });

  it.each(["session", "model", "provider", "remove", "archive"])("retries next tick after %s changes with permanently pending old usage", async (identity) => {
    const context = harness([agent({ id: "pi-1" }), agent({ id: "pi-2" })]);
    context.snapshotRpc.mockImplementationOnce(() => new Promise(() => {}));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startUsagePills(context.client);
    try {
      await advance(0);
      if (identity === "remove") context.emit({ kind: "remove", agentId: "pi-1" });
      else context.emit({ kind: "upsert", agent: agent({ id: "pi-1",
        ...(identity === "session" ? { persistence: { provider: "pi", sessionId: "s2" } }
          : identity === "model" ? { model: "new-model" }
          : identity === "provider" ? { provider: "codex" } : { archivedAt: new Date(NOW).toISOString() }),
      }) });
      if (["provider", "remove", "archive"].includes(identity)) {
        context.emit({ kind: "upsert", agent: agent({ id: "pi-1" }) });
      }
      await advance(0);
      await advance(2500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
      expect([...context.polled[1]].sort()).toEqual(["pi-1", "pi-2"]);
      expect(context.pills.get("pi-2")?.label).toBe("— 42%");
      await advance(12_500);
      expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("keeps the current batch pending across unchanged upserts and changes outside the batch", async () => {
    const context = harness([agent({ id: "pi-1" }), agent({ id: "pi-2" })]);
    const stop = startUsagePills(context.client);
    await advance(0);
    context.snapshotRpc.mockImplementationOnce(() => new Promise(() => {}));
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", lastUserMessageAt: new Date(NOW - 9 * HOUR).toISOString() }) });
    await advance(2500);
    expect(context.polled[1]).toEqual(["pi-1"]);
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", lastUserMessageAt: new Date(NOW - 9 * HOUR).toISOString() }) });
    context.emit({ kind: "upsert", agent: agent({ id: "pi-2", model: "new-model" }) });
    await advance(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(2);
    stop();
  });

  it("asks for the snapshot through the plugin RPC contract", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await advance(0);

    expect(context.rpc.mock.calls[0][0]).toBe(piUsageSnapshotRpc);
    stop();
  });
});
