import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "./index.server";
import { piBalanceRpc } from "./shared/balance";
import { piUsageCallsRpc, piUsageSnapshotRpc } from "./shared/usage";

const services = vi.hoisted(() => ({
  usageSnapshot: vi.fn(() => "usage-result"),
  calls: vi.fn(() => "calls-result"),
  balanceSnapshot: vi.fn(() => "balance-result"),
  clear: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("./server/usageService", () => ({
  PiUsageService: class {
    snapshot = services.usageSnapshot;
    calls = services.calls;
  },
}));
vi.mock("./server/balanceService", () => ({
  BalanceService: class {
    snapshot = services.balanceSnapshot;
    clear = services.clear;
    dispose = services.dispose;
  },
}));

type Agent = { id: string; cwd: string; workspaceId: string | null; provider: string };
type Handler = (event: { agent: Agent; turnId?: string | null; archivedAt?: string }) => void | Promise<void>;
type RpcHandler = (input: unknown, context: { paseo: unknown }) => unknown;

function createServer() {
  const listeners = new Map<string, Handler>();
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  const on = vi.fn((name: string, handler: Handler) => {
    listeners.set(name, handler);
    const unsubscribe = vi.fn(() => { listeners.delete(name); });
    unsubscribes.set(name, unsubscribe);
    return unsubscribe;
  });
  const rpcs = new Map<unknown, RpcHandler>();
  const handle = vi.fn((contract: unknown, handler: RpcHandler) => { rpcs.set(contract, handler); });
  const server = { on, handle } as unknown as PluginServerContext;
  return { server, listeners, unsubscribes, rpcs, handle };
}

describe("index.server workspace marker lifecycle integration", () => {
  let root: string;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "paseo-workspace-entry-"));
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves all three RPC contracts and service argument forwarding", () => {
    const { server, rpcs, handle } = createServer();
    cleanup = contribute(server);
    expect(handle).toHaveBeenCalledTimes(3);
    expect([...rpcs.keys()]).toEqual([piUsageSnapshotRpc, piUsageCallsRpc, piBalanceRpc]);
    const paseo = {};
    const agentIds = ["agent-1", "agent-2"];
    expect(rpcs.get(piUsageSnapshotRpc)!({ agentIds }, { paseo })).toBe("usage-result");
    expect(services.usageSnapshot).toHaveBeenCalledWith(agentIds, paseo);
    expect(rpcs.get(piUsageCallsRpc)!({ agentId: "agent-1", limit: 12 }, { paseo })).toBe("calls-result");
    expect(services.calls).toHaveBeenCalledWith("agent-1", 12, paseo);
    const agent = { id: "agent-1" };
    expect(rpcs.get(piBalanceRpc)!({ agent, refresh: true }, { paseo })).toBe("balance-result");
    expect(services.balanceSnapshot).toHaveBeenCalledWith(agent, paseo, true);
  });

  it("enables both marker events, preserves archive clearing and cleans up every listener plus balance", async () => {
    const { server, listeners, unsubscribes } = createServer();
    cleanup = contribute(server);
    expect([...listeners.keys()]).toEqual(["agent.archived", "agent.created", "agent.turn_started"]);
    const agent = { id: "agent-1", cwd: join(root, "nested"), workspaceId: "first", provider: "codex" };
    expect(existsSync(agent.cwd)).toBe(false);
    const created = listeners.get("agent.created")!;
    const turnStarted = listeners.get("agent.turn_started")!;
    await created({ agent });
    const marker = join(agent.cwd, ".paseo-workspace-id");
    expect(readFileSync(marker, "utf8")).toBe("first\n");
    await turnStarted({ agent: { ...agent, workspaceId: "second" }, turnId: "turn" });
    expect(readFileSync(marker, "utf8")).toBe("second\n");
    await listeners.get("agent.archived")!({ agent, archivedAt: "2026-01-01T00:00:00Z" });
    expect(services.clear).toHaveBeenCalledExactlyOnceWith(agent.id);
    expect(services.dispose).not.toHaveBeenCalled();

    cleanup();
    cleanup = undefined;
    expect(listeners.size).toBe(0);
    for (const unsubscribe of unsubscribes.values()) expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(services.dispose).toHaveBeenCalledTimes(1);
    await created({ agent: { ...agent, workspaceId: "late-created" } });
    await turnStarted({ agent: { ...agent, workspaceId: "late-turn" }, turnId: null });
    expect(readFileSync(marker, "utf8")).toBe("second\n");
  });
});
