import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  calls: vi.fn(),
  balance: vi.fn(),
  close: vi.fn(),
  agent: { status: "idle", title: "统计 token" } as { status: string; title: string; model?: string; persistence?: { sessionId: string } } | null,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: { name: string }) => (rpc.name === "pi-usage.snapshot" ? mocks.snapshot : rpc.name === "pi-usage.balance" ? mocks.balance : mocks.calls),
  useAgent: () => mocks.agent,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Button",
  ScrollView: "ScrollView",
}));

import { PiUsagePopover } from "./panel";
import { createPillBalanceDiagnostic } from "./pillBalanceDiagnostics";
import type { UsageSnapshot } from "../shared/usage";

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
    foreground: "#18181b",
    foregroundMuted: "#71717a",
    accent: "#386f4d",
    accentForeground: "#ffffff",
    statusSuccess: "#386f4d",
    statusWarning: "#916c19",
    statusDanger: "#94433e",
  },
};

const popoverProps = {
  theme,
  layout: { compact: false, platform: "web" },
  host: { id: "test", label: "Test host" },
  context: "agent",
  workspaceId: "wks_1",
  agentId: "agent-1",
  close: mocks.close,
} as unknown as PluginButtonContentProps;

const okSnapshot: UsageSnapshot = {
  agentId: "agent-1",
  status: "ok",
  error: null,
  provider: "pi",
  model: "aliyun/qwen3.8-max",
  thinkingLevel: "xhigh",
  sessionId: "01a08f7c",
  sessionFile: "/home/user/.pi/agent/sessions/--home-user-pi-demo--/2026-09-11_01a08f7c.jsonl",
  totals: { input: 180_704, output: 69_842, cacheRead: 7_964_160, cacheWrite: 0, reasoning: 32_862, cost: 0.4213 },
  totalTokens: 8_214_706,
  calls: 79,
  userTurns: 3,
  compactions: 1,
  contextUsedTokens: 167_727,
  contextWindowTokens: 262_144,
  contextPercent: 63.98,
  contextStale: false,
  cacheHitRate: 99.56,
  startedAt: "2026-09-11T08:01:59.655Z",
  lastActivityAt: "2026-09-11T08:35:26.340Z",
  fileBytes: 667_715,
};

const okCalls = {
  agentId: "agent-1",
  status: "ok" as const,
  error: null,
  truncated: true,
  perModel: [
    { key: "aliyun/qwen3.8-max", tokens: 8_000_000, cost: 0.4 },
    { key: "Tools/summaries", tokens: 214_706, cost: 0.02 },
  ],
  calls: [
    {
      index: 79,
      at: "2026-09-11T08:35:26.340Z",
      provider: "aliyun",
      model: "qwen3.8-max",
      input: 730,
      output: 85,
      cacheRead: 166_912,
      cacheWrite: 0,
      reasoning: 6,
      cost: 0.004,
      totalTokens: 167_727,
      contextTokens: 167_727,
      stopReason: "toolUse",
    },
  ],
};

let renderer: ReactTestRenderer;
let queryClient: QueryClient;

function renderPopover(props: PluginButtonContentProps = popoverProps) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return act(async () => {
    renderer = create(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover, props)),
    );
  });
}

async function flush() {
  // react-query notifies through batched micro/macrotasks; hop until the tree settles.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const visible = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.agent = { status: "idle", title: "统计 token" };
  mocks.snapshot.mockResolvedValue({ readAt: "2026-09-11T08:40:00.000Z", agents: [okSnapshot] });
  mocks.calls.mockResolvedValue(okCalls);
  mocks.balance.mockResolvedValue({ balance: 222, unit: "CNY", total: 500 });
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  queryClient?.clear();
});

test("renders cumulative totals, context and per-call detail", async () => {
  await renderPopover();
  await flush();

  const text = visible();
  expect(renderer.root.findAll((node) => (node.type as unknown as string) === "Text")
    .map((node) => node.children.join(""))
    .filter((label) => ["总 token", "上下文", "余额"].includes(label))
    .slice(0, 3)).toEqual(["总 token", "上下文", "余额"]);
  expect(text).toContain("π Token 用量");
  // The subtitle is the session title, explicitly labelled so it reads as metadata.
  expect(text).toContain("会话：统计 token");
  // Hero numbers.
  expect(text).toContain("8.2M"); // total tokens
  expect(text).toContain("8,214,706");
  expect(text).toContain("￥222.00 / ￥500.00");
  expect(text).toContain("44.4%");
  expect(text).not.toContain("花费");
  for (const cost of ["$0.421", "$0.400", "$0.020", "$0.004"]) expect(text).not.toContain(cost);
  expect(text).toContain("64%"); // context percent
  expect(text).toContain("已用 168k / 262k"); // context used / window
  // Breakdown rows.
  expect(text).toContain("R 缓存读");
  expect(text).toContain("8.0M");
  expect(text).toContain("✳ 思考");
  expect(text).toContain("99.6%");
  expect(text).toContain("命中率 · 全会话");
  expect(text).toContain("= ↑输入 + ↓输出 + R缓存读 + W缓存写");
  expect(text).toContain("97.8%"); // ΣcacheRead / Σprompt tokens
  expect(text).not.toContain("与 Pi 状态栏同口径");
  // Session facts.
  expect(text).toContain("aliyun/qwen3.8-max");
  expect(text).toContain("thinking xhigh");
  expect(text).toContain("用户轮次 3");
  expect(text).toContain("压缩 1 次");
  // Per-model + call table.
  expect(text).toContain("Tools/summaries");
  expect(text).toContain("qwen3.8-max");
  expect(text).toContain("79");
  expect(text).toContain("更早的调用已从内存中丢弃");
  // Session file.
  expect(text).toContain("652.1 KB");
  expect(mocks.snapshot).toHaveBeenCalledWith({ agentIds: ["agent-1"] });
  expect(mocks.calls).toHaveBeenCalledWith({ agentId: "agent-1", limit: 40 });
});

test("close button dismisses the popover through the host close callback", async () => {
  await renderPopover();
  await flush();

  const close = renderer.root.find((node) => node.props?.accessibilityLabel === "关闭 Token 面板");
  expect(close.find((node) => (node.type as unknown as string) === "Text").children.join("")).toBe("关闭");
  act(() => {
    close.props.onPress();
  });

  expect(mocks.close).toHaveBeenCalled();
});

test("hides the wide call columns even on wide layouts", async () => {
  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("8.2M");
  expect(text).not.toContain(" ctx");
});

test("explains a surface outside an agent context", async () => {
  await renderPopover({ ...popoverProps, context: "workspace", agentId: undefined } as unknown as PluginButtonContentProps);
  await flush();

  expect(visible()).toContain("该表面只服务于 agent 上下文");
});

test("explains a session that has not started yet", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "no_session", sessionFile: null, totalTokens: 0 }],
  });

  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("Pi 会话文件还没生成");
  expect(text).not.toContain("按模型拆分");
});

test("explains non-Pi agents instead of showing zeroes", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "not_pi", provider: "codex" }],
  });

  await renderPopover();
  await flush();

  expect(visible()).toContain("本插件只统计 Pi 会话");
});

test("surfaces a failing read", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "error", error: "EACCES", sessionFile: null, totalTokens: 0 }],
  });

  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("读取失败：");
  expect(text).toContain("EACCES");
  expect(text).not.toContain("会话文件");
});

test("marks context unknown after a compaction like Pi does", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, contextStale: true, contextPercent: null }],
  });

  await renderPopover();
  await flush();

  expect(contextStatus().findAll((node) => (node.type as unknown as string) === "Text")
    .map((node) => node.children.join(""))).toEqual(["上下文", "?", "压缩后待更新 · 已用 168k / 262k"]);
  expect(statusBarWidths(contextStatus())).toEqual([]);
});

function usageStatus(label: string) {
  return renderer.root.find((node) => (node.type as unknown as string) === "Text" && node.children.join("") === label).parent!.parent!;
}

const contextStatus = () => usageStatus("上下文");
const balanceCard = () => usageStatus("余额");
const balanceCardText = () => balanceCard().findAll((node) => (node.type as unknown as string) === "Text").map((node) => node.children.join("")).join(" ");
const statusBarWidths = (status: ReturnType<typeof usageStatus>) => status.findAll((node) => Array.isArray(node.props.style) && node.props.style.some((style: { width?: string }) => style?.width !== undefined))
  .map((node) => node.props.style.find((style: { width?: string }) => style?.width !== undefined).width);
const balanceBarWidths = () => statusBarWidths(balanceCard());

test.each([
  { used: 0, stale: false, percent: null, detail: "已用 0 / 窗口未知" },
  { used: 167_727, stale: false, percent: 63.98, detail: "已用 168k / 窗口未知" },
  { used: 0, stale: true, percent: null, detail: "压缩后待更新 · 已用 0 / 窗口未知" },
])("context with unknown window keeps its full state ($detail)", async ({ used, stale, percent, detail }) => {
  mocks.snapshot.mockResolvedValue({
    agents: [{ ...okSnapshot, contextUsedTokens: used, contextWindowTokens: null, contextPercent: percent, contextStale: stale }],
  });
  await renderPopover();
  await flush();
  const texts = contextStatus().findAll((node) => (node.type as unknown as string) === "Text");
  expect(texts.map((node) => node.children.join(""))).toEqual(["上下文", percent === null ? "?" : "64%", detail]);
  expect(texts[2].props.numberOfLines).toBeUndefined();
  expect(statusBarWidths(contextStatus())).toEqual([]);
});

test.each([true, false])("long balance values and details can wrap in compact layout %s", async (compact) => {
  mocks.balance.mockResolvedValue({ balance: 123_456_789_012_345.67, unit: "CNY", total: 987_654_321_098_765.4 });
  await renderPopover({ ...popoverProps, layout: { ...popoverProps.layout, compact } });
  await flush();
  const texts = balanceCard().findAll((node) => (node.type as unknown as string) === "Text");
  expect(texts.map((node) => node.children.join(""))).toEqual([
    "余额", "￥123456789012345.67", "￥123456789012345.67 / ￥987654321098765.38",
  ]);
  for (const node of texts.slice(1)) {
    expect(node.props.numberOfLines).toBeUndefined();
    expect(node.props.ellipsizeMode).toBeUndefined();
  }
  expect(texts[1].parent!.props.style.flexWrap).toBe("wrap");
});

test.each([[0, "0%"], [222, "44.4%"], [600, "100%"], [-10, "0%"]])("balance card clamps progress for balance %s", async (balance, width) => {
  mocks.balance.mockResolvedValue({ balance, unit: "CNY", total: 500 });
  await renderPopover();
  await flush();
  expect(balanceCardText()).toContain(`￥${balance.toFixed(2)} / ￥500.00`);
  expect(balanceBarWidths()).toEqual([width]);
});

test.each([undefined, null, 0, -1, NaN, Infinity, "500"])("balance card keeps the balance with unknown total %s", async (total) => {
  mocks.balance.mockResolvedValue({ balance: 222, unit: "USD", total });
  await renderPopover();
  await flush();
  expect(balanceCardText()).toContain("$222.00 / ?");
  expect(balanceBarWidths()).toEqual([]);
});

test.each(["loading", "failure"])("balance %s does not block usage", async (state) => {
  if (state === "loading") mocks.balance.mockImplementation(() => new Promise(() => {}));
  else mocks.balance.mockRejectedValue(new Error("balance unavailable"));
  await renderPopover();
  await flush();
  expect(balanceCardText()).toContain("? / ?");
  expect(balanceBarWidths()).toEqual([]);
  expect(visible()).toContain("8.2M");
  expect(renderer.root.findAll((node) => (node.type as unknown as string) === "Text").map((node) => node.children.join("")).join(" ")).toContain("最近 40 次 LLM 调用");
});

test.each(["loaded", "loading"])("refresh requests fresh usage and balance while balance is %s", async (state) => {
  if (state === "loading") mocks.balance.mockImplementation(() => new Promise(() => {}));
  await renderPopover();
  await flush();
  mocks.snapshot.mockClear();
  mocks.calls.mockClear();
  mocks.balance.mockClear().mockResolvedValue({ balance: 100, unit: "CNY", total: 500 });
  await act(async () => {
    renderer.root.find((node) => node.props.accessibilityLabel === "立即刷新 Pi token 用量").props.onPress();
  });
  await flush();
  expect(mocks.snapshot).toHaveBeenCalledWith({ agentIds: ["agent-1"] });
  expect(mocks.calls).toHaveBeenCalledWith({ agentId: "agent-1", limit: 40 });
  expect(mocks.balance).toHaveBeenCalledWith({ agent: "agent-1", refresh: true });
  expect(balanceCardText()).toContain("￥100.00 / ￥500.00");
  expect(balanceBarWidths()).toEqual(["20%"]);
});

test("balance query isolates cached data when switching agents A to B to A", async () => {
  await renderPopover();
  await flush();
  expect(balanceCardText()).toContain("￥222.00 / ￥500.00");

  const agentBProps = { ...popoverProps, agentId: "agent-2" } as PluginButtonContentProps;
  mocks.snapshot.mockResolvedValue({ agents: [{ ...okSnapshot, agentId: "agent-2" }] });
  let finish!: (value: { balance: number; unit: string; total: number }) => void;
  mocks.balance.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => {
    renderer.update(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover, agentBProps)));
  });
  await flush();
  expect(balanceCardText()).toContain("? / ?");
  expect(balanceCardText()).not.toContain("￥222.00");
  expect(balanceBarWidths()).toEqual([]);
  await act(async () => { finish({ balance: 333, unit: "CNY", total: 500 }); });
  await flush();
  expect(balanceCardText()).toContain("￥333.00 / ￥500.00");

  mocks.snapshot.mockResolvedValue({ agents: [okSnapshot] });
  mocks.balance.mockClear();
  await act(async () => {
    renderer.update(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover, popoverProps)));
  });
  expect(balanceCardText()).toContain("? / ?");
  await flush();
  expect(mocks.balance).toHaveBeenCalledWith({ agent: "agent-1", refresh: false });
  expect(balanceCardText()).toContain("? / ?");
  expect(balanceCardText()).not.toContain("￥222.00");
  expect(balanceCardText()).not.toContain("￥333.00");
  expect(balanceBarWidths()).toEqual([]);
  expect(visible()).toContain("8.2M");
  expect(renderer.root.findAll((node) => (node.type as unknown as string) === "Text").map((node) => node.children.join("")).join(" ")).toContain("最近 40 次 LLM 调用");
  expect(visible()).not.toContain("花费");

  await act(async () => { finish({ balance: 100, unit: "CNY", total: 500 }); });
  await flush();
  expect(balanceCardText()).toContain("￥100.00 / ￥500.00");
  expect(balanceBarWidths()).toEqual(["20%"]);
});

test.each(["agent", "model", "session"])("balance query clears old data when %s changes", async (identity) => {
  await renderPopover();
  await flush();
  expect(balanceCardText()).toContain("￥222.00");
  let finish!: (value: { balance: number; unit: string; total: number }) => void;
  mocks.balance.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  if (identity === "agent") mocks.snapshot.mockResolvedValue({ agents: [{ ...okSnapshot, agentId: "agent-2" }] });
  if (identity === "session") {
    mocks.snapshot.mockResolvedValue({ agents: [{ ...okSnapshot, sessionId: "new-session" }] });
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["pi-usage", "snapshot"] }); });
  } else {
    if (identity === "model") mocks.agent = { status: "idle", title: "统计 token", model: "new/model" };
    await act(async () => {
      renderer.update(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover,
        identity === "agent" ? { ...popoverProps, agentId: "agent-2" } as PluginButtonContentProps : popoverProps)));
    });
  }
  await flush();
  expect(balanceCardText()).toContain("? / ?");
  expect(balanceCardText()).not.toContain("￥222.00");
  await act(async () => { finish({ balance: 10, unit: "USD", total: 50 }); });
  await flush();
  expect(balanceCardText()).toContain("$10.00 / $50.00");
  expect(balanceBarWidths()).toEqual(["20%"]);
});

test("popover observes component diagnostics independently of its own balance", async () => {
  const diagnostic = createPillBalanceDiagnostic("agent-1");
  const other = createPillBalanceDiagnostic("agent-2");
  try {
    diagnostic.mount(1);
    diagnostic.query("pending", true);
    await renderPopover();
    await flush();
    expect(balanceCardText()).toContain("￥222.00");
    expect(visible()).toContain("Icon挂载 1");
    expect(visible()).toContain("查询中 1");
    await act(async () => { other.publish("error", false); });
    expect(visible()).toContain("Pill 余额诊断：pending");
    await act(async () => { diagnostic.publish("error", false); });
    expect(visible()).toContain("Pill 余额诊断：error");
    await act(async () => { diagnostic.publish("success", true); });
    expect(visible()).not.toContain("Pill 余额诊断：");
    await act(async () => { diagnostic.dispose(); });
    expect(visible()).not.toContain("Pill 余额诊断：");
  } finally {
    act(() => { diagnostic.dispose(); other.dispose(); });
  }
});

test("popover switches component diagnostic subscription with the agent", async () => {
  const a = createPillBalanceDiagnostic("agent-1");
  const b = createPillBalanceDiagnostic("agent-2");
  try {
    a.publish("error", false);
    b.publish("empty", false);
    await renderPopover();
    expect(visible()).toContain("Pill 余额诊断：error");
    await act(async () => {
      renderer.update(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(PiUsagePopover, { ...popoverProps, agentId: "agent-2" } as PluginButtonContentProps)));
    });
    expect(visible()).toContain("Pill 余额诊断：empty");
    await act(async () => { a.publish("pending", false); });
    expect(visible()).toContain("Pill 余额诊断：empty");
    await act(async () => { b.publish("success", true); });
    expect(visible()).not.toContain("Pill 余额诊断：");
  } finally {
    act(() => { a.dispose(); b.dispose(); });
  }
});

test.each([true, false])("popover without pill store shows version and hides after 12 seconds only with normal panel balance (%s)", async (normal) => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  if (!normal) mocks.balance.mockResolvedValue({ balance: null, unit: null });
  try {
    await renderPopover();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(visible()).toContain("diag-v7-query-icon；pill状态未注册");
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(visible()).toContain("pill状态未注册");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(visible().includes("pill状态未注册")).toBe(!normal);
    await act(async () => {
      renderer.update(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(PiUsagePopover, { ...popoverProps, agentId: "agent-2" } as PluginButtonContentProps)));
    });
    expect(visible()).toContain("pill状态未注册");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => { renderer.unmount(); });
    queryClient.clear();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
