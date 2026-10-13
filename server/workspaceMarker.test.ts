import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceMarker } from "./workspaceMarker";

type MarkerEvent = "agent.created" | "agent.turn_started";
type Agent = { cwd?: string; workspaceId?: string | null; provider: string };
type Handler = (event: { agent: Agent; turnId?: string | null }) => void | Promise<void>;

function createServer() {
  const listeners = new Map<MarkerEvent, Handler>();
  const unsubscribes = new Map<MarkerEvent, ReturnType<typeof vi.fn>>();
  const on = vi.fn((name: MarkerEvent, handler: Handler) => {
    listeners.set(name, handler);
    const unsubscribe = vi.fn(() => { listeners.delete(name); });
    unsubscribes.set(name, unsubscribe);
    return unsubscribe;
  });
  const server = { on } as unknown as PluginServerContext;
  return { server, on, listeners, unsubscribes };
}

const events: MarkerEvent[] = ["agent.created", "agent.turn_started"];

describe("registerWorkspaceMarker", () => {
  let root: string;
  let cleanup: (() => void) | undefined;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "paseo-workspace-marker-")); });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(events)("%s recursively creates cwd and writes UTF-8 ID with a newline for any provider", async (name) => {
    const { server, on, listeners } = createServer();
    const cwd = join(root, "nested", "工作区");
    cleanup = registerWorkspaceMarker(server);
    expect(on.mock.calls.map(([event]) => event)).toEqual(events);
    expect(existsSync(cwd)).toBe(false);

    for (const provider of ["pi", "claude", "codex", "custom-provider"]) {
      const workspaceId = `工作区-${provider}`;
      await listeners.get(name)!({ agent: { cwd, workspaceId, provider }, turnId: null });
      expect(readFileSync(join(cwd, ".paseo-workspace-id"))).toEqual(Buffer.from(workspaceId + "\n", "utf8"));
    }
  });

  it.each(events)("%s skips missing or empty cwd/workspaceId", async (name) => {
    const { server, listeners } = createServer();
    cleanup = registerWorkspaceMarker(server);
    const cwd = join(root, "must-not-exist");
    for (const agent of [
      { provider: "pi", workspaceId: "workspace" },
      { provider: "pi", cwd: "", workspaceId: "workspace" },
      { provider: "pi", cwd },
      { provider: "pi", cwd, workspaceId: null },
      { provider: "pi", cwd, workspaceId: "" },
    ]) {
      await expect(Promise.resolve(listeners.get(name)!({ agent, turnId: "turn" }))).resolves.toBeUndefined();
    }
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(root, ".paseo-workspace-id"))).toBe(false);
  });

  it("overwrites an existing marker and retains the last event's workspace ID in a shared cwd", async () => {
    const { server, listeners } = createServer();
    const marker = join(root, ".paseo-workspace-id");
    writeFileSync(marker, "old contents");
    cleanup = registerWorkspaceMarker(server);
    await listeners.get("agent.created")!({ agent: { cwd: root, workspaceId: "first", provider: "pi" } });
    expect(readFileSync(marker, "utf8")).toBe("first\n");
    await listeners.get("agent.turn_started")!({ agent: { cwd: root, workspaceId: "second", provider: "codex" }, turnId: "turn" });
    expect(readFileSync(marker, "utf8")).toBe("second\n");
  });

  it.each(["mkdir", "write"])("suppresses %s failure and retries successfully on a later turn", async (failure) => {
    const { server, listeners } = createServer();
    const cwd = join(root, "workspace");
    const marker = join(cwd, ".paseo-workspace-id");
    if (failure === "mkdir") writeFileSync(cwd, "blocking file");
    else mkdirSync(marker, { recursive: true });
    cleanup = registerWorkspaceMarker(server);
    const agent = { cwd, workspaceId: "retry-workspace", provider: "other" };
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const log = vi.spyOn(console, "log");
    try {
      await expect(Promise.resolve(listeners.get("agent.created")!({ agent }))).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      if (failure === "mkdir") rmSync(cwd);
      else rmSync(marker, { recursive: true });
      await listeners.get("agent.turn_started")!({ agent, turnId: null });
      expect(readFileSync(marker, "utf8")).toBe("retry-workspace\n");
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("unsubscribes both listeners once and ignores retained callbacks after cleanup", async () => {
    const { server, listeners, unsubscribes } = createServer();
    cleanup = registerWorkspaceMarker(server);
    const callbacks = [...listeners.values()];
    const marker = join(root, ".paseo-workspace-id");
    writeFileSync(marker, "keep\n");
    cleanup();
    cleanup();
    expect(listeners.size).toBe(0);
    for (const event of events) expect(unsubscribes.get(event)).toHaveBeenCalledTimes(1);
    for (const callback of callbacks) {
      await callback({ agent: { cwd: root, workspaceId: "late", provider: "pi" }, turnId: null });
      await callback({ agent: { cwd: join(root, "late-directory"), workspaceId: "late", provider: "pi" } });
    }
    expect(readFileSync(marker, "utf8")).toBe("keep\n");
    expect(existsSync(join(root, "late-directory"))).toBe(false);
  });
});
