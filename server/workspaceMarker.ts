import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerWorkspaceMarker(server: PluginServerContext): () => void {
  let disposed = false;

  function writeMarker({ agent }: { agent: { cwd: string; workspaceId: string | null } }) {
    if (disposed || !agent.cwd || !agent.workspaceId) return;

    try {
      mkdirSync(agent.cwd, { recursive: true });
      writeFileSync(join(agent.cwd, ".paseo-workspace-id"), agent.workspaceId + "\n", "utf8");
    } catch {
      // 标记写入失败不能阻断 agent；后续事件会再次尝试。
    }
  }

  const created = server.on("agent.created", writeMarker);
  const turnStarted = server.on("agent.turn_started", writeMarker);

  return () => {
    if (disposed) return;
    disposed = true;
    created();
    turnStarted();
  };
}
