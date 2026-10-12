import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piBalanceRpc, type PiBalance } from "../shared/balance";
import { piUsageSnapshotRpc, type UsageSnapshot } from "../shared/usage";
import { startUsagePills } from "./pills";

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: vi.fn(),
  useAgent: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Button",
  ScrollView: "ScrollView",
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
  const pills = new Map<string, FakePill>();
  const polled: string[][] = [];
  const listeners: Array<(update: unknown) => void> = [];

  const addComposerPill = vi.fn((contribution: { agentId: string; button: { title: string; label?: string } }) => {
    const pill: FakePill = {
      agentId: contribution.agentId,
      title: contribution.button.title,
      label: contribution.button.label ?? "",
      removed: false,
      presses: 0,
      update(patch: { label?: string; title?: string }) {
        if (patch.label !== undefined) this.label = patch.label;
        if (patch.title !== undefined) this.title = patch.title;
      },
      remove() {
        this.removed = true;
        pills.delete(this.agentId);
      },
    };
    pills.set(contribution.agentId, pill);
    return pill;
  });

  const balanceRpc = vi.fn(async (): Promise<PiBalance> => ({ balance: null, unit: null }));
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

describe("startUsagePills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
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
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);

    // Bootstrap polls every tracked agent once, newest first from the batch result.
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);
    expect(context.pills.get("hot")?.label).toBe("— 42%");
    expect(context.pills.get("cold")?.label).toBe("— 42%");

    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.polled).toEqual([["hot"]]);

    // A status change makes a quiet agent worth one more read.
    context.polled.length = 0;
    context.emit({ kind: "upsert", agent: agent({ id: "cold", status: "running", updatedAt: new Date(NOW).toISOString() }) });
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);

    stop();
  });

  it("drops the pill when the agent goes away", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.has("pi-1")).toBe(true);

    context.emit({ kind: "remove", agentId: "pi-1" });
    expect(context.pills.has("pi-1")).toBe(false);

    context.emit({ kind: "upsert", agent: agent({ id: "pi-2" }) });
    expect(context.pills.has("pi-2")).toBe(true);
    context.emit({ kind: "upsert", agent: agent({ id: "pi-2", archivedAt: new Date(NOW).toISOString() }) });
    expect(context.pills.has("pi-2")).toBe(false);

    stop();
  });

  it("opens the token view as a pill popover", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    const contribution = context.addComposerPill.mock.calls[0][0] as unknown as {
      button: { icon: string; label: string; behavior: { kind: string; Content: unknown } };
    };
    expect(contribution.button.icon).toBe("Gauge");
    expect(contribution.button.label).toBe("— ?%");
    expect(contribution.button.behavior.kind).toBe("popover");
    expect(typeof contribution.button.behavior.Content).toBe("function");

    stop();
  });

  it("keeps the previous label and stops polling after cleanup", async () => {
    const context = harness([agent({ id: "hot", status: "running", updatedAt: new Date(NOW).toISOString() })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    const label = context.pills.get("hot")?.label;
    expect(label).toBe("— 42%");

    context.rpc.mockRejectedValueOnce(new Error("daemon gone"));
    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.pills.get("hot")?.label).toBe(label);

    stop();
    expect(context.pills.size).toBe(0);
    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
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
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");
    expect(context.pills.get("pi-1")?.title).not.toContain("余额");
    stop();
  });

  it("ignores a delayed balance after cleanup", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    let resolveBalance!: (value: PiBalance) => void;
    context.balanceRpc.mockImplementationOnce(() => new Promise(resolve => { resolveBalance = resolve; }));
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    const pill = context.pills.get("pi-1")!;
    stop();
    resolveBalance({ balance: 999, unit: "USD" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.label).toBe("— 42%");
    expect(context.pills.size).toBe(0);
  });

  it.each(["session", "model", "provider"])("invalidates a delayed balance immediately on %s upsert", async (identity) => {
    const context = harness([agent({ id: "pi-1", status: "running" })]);
    context.balanceRpc.mockResolvedValue({ balance: 200, unit: "USD" });
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    const oldPill = context.pills.get("pi-1")!;
    expect(oldPill.label).toBe("$200.00 42%");

    let resolveOld!: (value: PiBalance) => void;
    context.balanceRpc.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(context.balanceRpc).toHaveBeenCalledTimes(2);

    const change = identity === "session"
      ? { persistence: { provider: "pi", sessionId: "s2" } }
      : identity === "model" ? { model: "new-model" } : { provider: "codex" };
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", status: "running", ...change }) });
    if (identity === "provider") {
      expect(oldPill.removed).toBe(true);
      expect(context.pills.has("pi-1")).toBe(false);
      context.emit({ kind: "upsert", agent: agent({ id: "pi-1", status: "running" }) });
    } else {
      expect(oldPill.label).toBe("— ?%");
      expect(oldPill.title).not.toContain("余额");
    }
    const clearedLabel = context.pills.get("pi-1")!.label;

    let resolveSnapshot!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.balanceRpc).toHaveBeenCalledTimes(2);
    resolveOld({ balance: 999, unit: "USD" });
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.get("pi-1")?.label).toBe(clearedLabel);
    expect(context.pills.get("pi-1")?.title).not.toContain("余额");

    context.balanceRpc.mockResolvedValue({ balance: 300, unit: "CNY" });
    resolveSnapshot({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000),
        sessionId: identity === "session" ? "s2" : "s1",
        model: identity === "model" ? "new-model" : "aliyun/qwen3.8-max",
      }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(context.balanceRpc).toHaveBeenCalledTimes(3);
    expect(context.pills.get("pi-1")?.label).toBe("¥300.00 42%");
    stop();
  });

  it.each(["session", "model", "provider"])("rejects in-flight usage after idle %s changes and retries", async (identity) => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");

    let resolveOld!: (value: Awaited<ReturnType<typeof context.snapshotRpc>>) => void;
    context.snapshotRpc.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", lastUserMessageAt: new Date(NOW - 9 * HOUR).toISOString() }) });
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(2);

    const change = identity === "session"
      ? { persistence: { provider: "pi", sessionId: "s2" } }
      : identity === "model" ? { model: "new-model" } : { provider: "codex" };
    context.emit({ kind: "upsert", agent: agent({ id: "pi-1", ...change }) });
    if (identity === "provider") {
      context.emit({ kind: "upsert", agent: agent({ id: "pi-1" }) });
    }
    expect(context.pills.get("pi-1")?.label).toBe("— ?%");
    resolveOld({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000), contextUsedTokens: 99_000, contextPercent: 99 }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.get("pi-1")?.label).toBe("— ?%");
    expect(context.pills.get("pi-1")?.title).not.toContain("上下文");
    expect(context.balanceRpc).toHaveBeenCalledTimes(1);

    context.snapshotRpc.mockResolvedValue({
      readAt: new Date(NOW).toISOString(),
      agents: [{ ...snapshotFor("pi-1", 1000),
        sessionId: identity === "session" ? "s2" : "s1",
        model: identity === "model" ? "new-model" : "aliyun/qwen3.8-max",
        contextUsedTokens: 77_000, contextWindowTokens: 272_000,
      }],
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    expect(context.pills.get("pi-1")?.label).toBe("— 42%");
    expect(context.balanceRpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.snapshotRpc).toHaveBeenCalledTimes(3);
    stop();
  });

  it("asks for the snapshot through the plugin RPC contract", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(context.rpc.mock.calls[0][0]).toBe(piUsageSnapshotRpc);
    stop();
  });
});
