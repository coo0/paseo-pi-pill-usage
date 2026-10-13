import { Dimensions } from "react-native";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { buildPillTooltip, formatPercent } from "../shared/format";
import { PI_USAGE_PANEL_ID, piUsageSnapshotRpc, type UsageSnapshot } from "../shared/usage";
import type { PiBalance } from "../shared/balance";
import { formatBalance } from "../shared/balanceFormat";
import { PiUsagePopover } from "./panel";
import { createPillBalanceDiagnostic } from "./pillBalanceDiagnostics";
import { createPillBalanceIcon } from "./pillBalanceIcon";

/**
 * Per-agent composer pill showing balance and context window occupancy.
 * The hover tooltip carries the full breakdown (tokens, cache, cost, context).
 *
 * Paseo's own agent snapshot only carries `lastUsage` (one turn), so totals come
 * from the daemon handler that reads Pi's session JSONL.
 */

const FAST_INTERVAL_MS = 2500;
const RPC_TIMEOUT_MS = 12_000;
const HOT_WINDOW_MS = 2 * 60_000;
const BATCH_SIZE = 40;
const MAX_POLLED_PER_TICK = 120;
const BOOTSTRAP_PAGE_SIZE = 200;
const MAX_BOOTSTRAP_PAGES = 5;
const ERROR_LOG_COOLDOWN_MS = 30_000;

interface TrackedAgent {
  id: string;
  workspaceId: string;
  status: string;
  /** Last time Paseo reported activity for this agent; 0 when unknown. */
  activityAt: number;
  /** Set when Paseo reports a change we have not reflected in a poll yet. */
  dirty: boolean;
  label: string | null;
  tooltip: string | null;
  registration: PluginButtonRegistration;
  snapshot: UsageSnapshot | null;
  balance: PiBalance | null;
  balanceIcon: ReturnType<typeof createPillBalanceIcon>;
  sessionId: string | null;
  model: string | null;
  snapshotToken: symbol | null;
  diagnostic: ReturnType<typeof createPillBalanceDiagnostic>;
}

interface AgentLike {
  id: string;
  provider: string;
  model?: string | null;
  persistence?: { sessionId: string; provider: string } | null;
  workspaceId?: string | null;
  status?: string | null;
  lastUserMessageAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  archivedAt?: string | null;
}

/** Paseo's agent snapshot has no `lastActivityAt`, so derive one. */
function activityOf(agent: AgentLike): number {
  for (const value of [agent.lastUserMessageAt, agent.updatedAt, agent.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function startUsagePills(client: PluginClientContext): () => void {
  const tracked = new Map<string, TrackedAgent>();
  let stopped = false;
  let inFlight = false;
  let cancelSnapshot: (() => void) | null = null;
  let snapshotDeadline: number | null = null;
  let snapshotRequestToken: symbol | null = null;
  let snapshotAgents = new Set<TrackedAgent>();
  let lastErrorLog = 0;
  let compact = Dimensions.get("window").width < 600;

  function labelFor(snapshot: UsageSnapshot, balance: string | null): string {
    const percent = snapshot.status === "ok" && !snapshot.contextStale ? snapshot.contextPercent : null;
    return `${balance?.replace(/^￥/, "¥") ?? "—"} ${formatPercent(percent)}%`;
  }

  function tooltipFor(snapshot: UsageSnapshot): string {
    return buildPillTooltip({
      status: snapshot.status,
      totals: snapshot.totals,
      contextPercent: snapshot.contextPercent,
    });
  }

  function cancelSnapshotFor(agent: TrackedAgent): void {
    if (!snapshotAgents.has(agent)) return;
    for (const member of snapshotAgents) member.snapshotToken = null;
    cancelSnapshot?.();
  }

  function track(agent: AgentLike): void {
    if (stopped) return;
    const workspaceId = agent.workspaceId ?? null;
    const eligible = agent.provider === "pi" && workspaceId !== null && !agent.archivedAt;
    const existing = tracked.get(agent.id);

    if (!eligible) {
      if (existing) {
        cancelSnapshotFor(existing);
        existing.balanceIcon.dispose();
        existing.registration.remove();
        tracked.delete(agent.id);
        existing.diagnostic.dispose();
      }
      return;
    }

    const status = agent.status ?? "idle";
    const activityAt = activityOf(agent);
    const sessionId = agent.persistence?.sessionId ?? null;
    const model = agent.model ?? null;

    if (existing) {
      if (existing.sessionId !== sessionId || existing.model !== model) {
        cancelSnapshotFor(existing);
        existing.sessionId = sessionId;
        existing.model = model;
        existing.snapshotToken = null;
        existing.balance = null;
        existing.balanceIcon.setIdentity({ agentId: existing.id, provider: agent.provider, sessionId, model });
        existing.snapshot = null;
        existing.dirty = true;
        render(existing);
      }
      if (existing.status !== status || existing.activityAt !== activityAt) {
        existing.status = status;
        existing.activityAt = activityAt;
        existing.dirty = true;
      }
      return;
    }

    const diagnostic = createPillBalanceDiagnostic(agent.id);
    const balanceIcon = createPillBalanceIcon(
      { agentId: agent.id, provider: agent.provider, sessionId, model },
      (value, state) => {
        const current = tracked.get(agent.id);
        if (stopped || current?.balanceIcon !== balanceIcon) return;
        current.balance = value;
        diagnostic.publish(state, formatBalance(value) !== null);
        render(current);
      },
      diagnostic,
    );
    const registration = client.addComposerPill({
      id: PI_USAGE_PANEL_ID,
      workspaceId: workspaceId as string,
      agentId: agent.id,
      button: {
        title: "Pi token 用量",
        icon: balanceIcon.Icon,
        label: compact ? "—" : "— ?%",
        behavior: {
          kind: "popover",
          Content: PiUsagePopover,
        },
      },
    });

    tracked.set(agent.id, {
      id: agent.id,
      workspaceId: workspaceId as string,
      status,
      activityAt,
      dirty: true,
      label: null,
      tooltip: null,
      registration,
      sessionId, model,
      diagnostic, balanceIcon,
      snapshot: null, balance: null, snapshotToken: null,
    });
  }

  function forget(agentId: string): void {
    const existing = tracked.get(agentId);
    if (!existing) return;
    cancelSnapshotFor(existing);
    existing.balanceIcon.dispose();
    existing.registration.remove();
    tracked.delete(agentId);
    existing.diagnostic.dispose();
  }

  /**
   * Running or recently active agents poll every tick; quiet ones only when
   * Paseo reports a change, so an idle directory costs one read per agent.
   */
  function pollTargets(now: number): string[] {
    const ids: string[] = [];
    for (const agent of tracked.values()) {
      const active =
        agent.status === "running" || agent.status === "initializing" || now - agent.activityAt < HOT_WINDOW_MS;
      if (agent.dirty || active) ids.push(agent.id);
    }
    return ids.slice(0, MAX_POLLED_PER_TICK);
  }

  function render(agent: TrackedAgent): void {
    const balance = formatBalance(agent.balance);
    const label = compact
      ? balance?.replace(/^￥/, "¥") ?? "—"
      : agent.snapshot ? labelFor(agent.snapshot, balance) : `${balance?.replace(/^￥/, "¥") ?? "—"} ?%`;
    const tooltip = (agent.snapshot ? tooltipFor(agent.snapshot) : "Pi token 用量") + (balance === null ? "" : ` · 余额 ${balance}`);
    if (label === agent.label && tooltip === agent.tooltip) return;
    agent.label = label;
    agent.tooltip = tooltip;
    agent.registration.update({ label, title: tooltip });
  }

  function applySnapshots(agents: readonly UsageSnapshot[], requests: Map<string, { agent: TrackedAgent; token: symbol }>): void {
    if (stopped) return;
    for (const snapshot of agents) {
      const agent = tracked.get(snapshot.agentId);
      const request = requests.get(snapshot.agentId);
      if (!agent || request?.agent !== agent || request.token !== agent.snapshotToken) continue;
      const previous = agent.snapshot;
      if (previous && (previous.sessionId !== snapshot.sessionId || previous.model !== snapshot.model || previous.provider !== snapshot.provider)) {
        agent.balance = null;
      }
      agent.balanceIcon.setIdentity({ agentId: agent.id, provider: snapshot.provider, sessionId: snapshot.sessionId, model: snapshot.model });
      agent.snapshot = snapshot;
      if (snapshot.status !== "error") agent.dirty = false;
      render(agent);
    }
  }

  async function requestSnapshots(agentIds: string[]) {
    const token = Symbol();
    snapshotRequestToken = token;
    snapshotDeadline = Date.now() + RPC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      cancelSnapshot = () => {
        if (snapshotRequestToken !== token || snapshotDeadline === null) return;
        snapshotDeadline = null;
        for (const agent of snapshotAgents) agent.snapshotToken = null;
        if (timer !== null) clearTimeout(timer);
        reject(new Error("snapshot request expired"));
      };
      timer = setTimeout(cancelSnapshot, RPC_TIMEOUT_MS);
    });
    try {
      // The race handles late rejections; only the winning response reaches applySnapshots.
      return await Promise.race([client.rpc(piUsageSnapshotRpc, { agentIds }), timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (snapshotRequestToken === token) {
        snapshotRequestToken = null;
        snapshotDeadline = null;
        cancelSnapshot = null;
        snapshotAgents.clear();
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    const agentIds = pollTargets(Date.now());
    if (agentIds.length === 0) return;

    inFlight = true;
    try {
      for (let i = 0; i < agentIds.length && !stopped; i += BATCH_SIZE) {
        const batch = agentIds.slice(i, i + BATCH_SIZE);
        const requests = new Map<string, { agent: TrackedAgent; token: symbol }>();
        for (const id of batch) {
          const agent = tracked.get(id);
          if (agent) {
            const token = Symbol();
            agent.snapshotToken = token;
            requests.set(id, { agent, token });
          }
        }
        snapshotAgents = new Set([...requests.values()].map(request => request.agent));
        const snapshotRequest = requestSnapshots(batch);
        const result = await snapshotRequest;
        applySnapshots(result.agents, requests);
      }
    } catch (error) {
      if (stopped) return;
      const now = Date.now();
      if (now - lastErrorLog > ERROR_LOG_COOLDOWN_MS) {
        lastErrorLog = now;
        console.error(`[pi-usage] snapshot poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      inFlight = false;
    }
  }

  const dimensionsSubscription = Dimensions.addEventListener("change", ({ window }) => {
    if (stopped) return;
    compact = window.width < 600;
    for (const agent of tracked.values()) render(agent);
  });

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") track(update.agent);
    else if (update.kind === "remove") forget(update.agentId);
  });

  // `agents.subscribe` only mirrors an observation, so own one to seed existing agents.
  let releaseDirectory: (() => void) | null = null;
  void (async () => {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_BOOTSTRAP_PAGES && !stopped; page += 1) {
        const directory = await client.paseo.agents.list({
          filter: { includeArchived: false },
          page: cursor ? { limit: BOOTSTRAP_PAGE_SIZE, cursor } : { limit: BOOTSTRAP_PAGE_SIZE },
          subscribe: page === 0 ? {} : undefined,
        });
        if (stopped) return;
        for (const entry of directory.entries) track(entry.agent);
        if (page === 0) {
          const subscription = (directory as { subscription?: { release?: () => void } }).subscription;
          if (subscription?.release) releaseDirectory = () => subscription.release?.();
        }
        if (!directory.pageInfo.hasMore || !directory.pageInfo.nextCursor) break;
        cursor = directory.pageInfo.nextCursor;
      }
      await tick();
    } catch (error) {
      if (stopped) return;
      console.error(`[pi-usage] agent directory bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  const timer = setInterval(() => {
    // Wall-clock deadlines recover stalled timeouts, including after background resume.
    const now = Date.now();
    if (snapshotDeadline !== null && now >= snapshotDeadline) cancelSnapshot?.();
    void tick();
  }, FAST_INTERVAL_MS);

  return () => {
    stopped = true;
    cancelSnapshot?.();
    clearInterval(timer);
    dimensionsSubscription.remove();
    unsubscribe();
    releaseDirectory?.();
    for (const agent of tracked.values()) {
      agent.balanceIcon.dispose();
      agent.registration.remove();
      agent.diagnostic.dispose();
    }
    tracked.clear();
  };
}
