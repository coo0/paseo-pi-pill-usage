// Temporary component-path observation; never stores RPC payloads or identity values.
export const PILL_BALANCE_DIAGNOSTIC_VERSION = "diag-v7-query-icon";
export type PillBalanceState = "pending" | "success" | "empty" | "error";
export interface PillBalanceDiagnostic {
  readonly version: typeof PILL_BALANCE_DIAGNOSTIC_VERSION;
  readonly mounted: number;
  readonly state: PillBalanceState;
  readonly fetching: boolean;
  readonly hasBalance: boolean;
  readonly publications: number;
}
const entries = new Map<string, { snapshot: PillBalanceDiagnostic }>();
const listeners = new Map<string, Set<() => void>>();
function notify(agentId: string) {
  for (const listener of listeners.get(agentId) ?? []) {
    try { listener(); } catch { /* Observation must not interrupt component updates. */ }
  }
}
export function getPillBalanceDiagnostic(agentId: string): PillBalanceDiagnostic | null {
  return entries.get(agentId)?.snapshot ?? null;
}
export function subscribePillBalanceDiagnostic(agentId: string, listener: () => void): () => void {
  let group = listeners.get(agentId);
  if (!group) listeners.set(agentId, group = new Set());
  group.add(listener);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(agentId);
  };
}
export function createPillBalanceDiagnostic(agentId: string) {
  const entry = { snapshot: Object.freeze<PillBalanceDiagnostic>({
    version: PILL_BALANCE_DIAGNOSTIC_VERSION, mounted: 0, state: "pending",
    fetching: false, hasBalance: false, publications: 0,
  }) };
  entries.set(agentId, entry);
  notify(agentId);
  function update(patch: Partial<PillBalanceDiagnostic>) {
    if (entries.get(agentId) !== entry) return;
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch });
    notify(agentId);
  }
  return {
    mount(delta: 1 | -1) { update({ mounted: Math.max(0, entry.snapshot.mounted + delta) }); },
    query(state: PillBalanceState, fetching: boolean) { update({ state, fetching }); },
    publish(state: PillBalanceState, hasBalance: boolean) {
      update({ state, hasBalance, publications: entry.snapshot.publications + 1 });
    },
    dispose() {
      if (entries.get(agentId) !== entry) return;
      entries.delete(agentId);
      notify(agentId);
    },
  };
}
export function formatPillBalanceDiagnostic(snapshot: PillBalanceDiagnostic, _now = Date.now()): string {
  return `Pill 余额诊断：${snapshot.state}；${snapshot.version}；Icon挂载 ${snapshot.mounted}；查询中 ${Number(snapshot.fetching)}；发布 ${snapshot.publications}；有效余额 ${Number(snapshot.hasBalance)}（临时）`;
}
