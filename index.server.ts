import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PiUsageService } from "./server/usageService";
import { piUsageCallsRpc, piUsageSnapshotRpc } from "./shared/usage";
import { BalanceService } from "./server/balanceService";
import { piBalanceRpc } from "./shared/balance";


export default function contribute(server: PluginServerContext) {
  const usage = new PiUsageService();
  const balance = new BalanceService();

  server.handle(piUsageSnapshotRpc, ({ agentIds }, { paseo }) => usage.snapshot(agentIds, paseo));
  server.handle(piUsageCallsRpc, ({ agentId, limit }, { paseo }) => usage.calls(agentId, limit, paseo));
  server.handle(piBalanceRpc, ({ agent, refresh }, { paseo }) => balance.snapshot(agent, paseo, refresh));

  const archived = server.on("agent.archived", ({ agent }) => balance.clear(agent.id));

  return () => { archived(); balance.dispose(); };
}
