import React, { useEffect, useSyncExternalStore } from "react";
import { useRpc, type PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon as HostIcon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { piBalanceRpc, type PiBalance } from "../shared/balance";
import { formatBalance } from "../shared/balanceFormat";
import type { createPillBalanceDiagnostic, PillBalanceState } from "./pillBalanceDiagnostics";

export interface PillBalanceIdentity {
  agentId: string;
  provider: string | null;
  sessionId: string | null;
  model: string | null;
}

// New registrations must not reuse requests observed before a registration was disposed.
// Keep epochs within the host QueryClient so concurrently active registrations still share.
const registrationEpochs = new WeakMap<QueryClient, Map<string, number>>();

// Owned by one registration. The host provides QueryClient and installation/host isolation.
export function createPillBalanceIcon(
  initial: PillBalanceIdentity,
  publish: (balance: PiBalance | null, state: PillBalanceState) => void,
  diagnostic: ReturnType<typeof createPillBalanceDiagnostic>,
) {
  let snapshot = { ...initial, generation: 0, active: true };
  const observedEpochs = new Map<QueryClient, Map<string, number>>();
  const listeners = new Set<() => void>();
  const leases = new Set<symbol>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const getSnapshot = () => snapshot;
  function notify() { for (const listener of listeners) listener(); }

  function BalanceIcon(props: PluginButtonIconProps) {
    const identity = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const rpc = useRpc(piBalanceRpc);
    const client = useQueryClient();
    const key = ["pi-usage", "pill-balance", identity.agentId, identity.provider, identity.sessionId, identity.model, identity.generation];
    const epochKey = JSON.stringify(key);
    let epochs = observedEpochs.get(client);
    if (!epochs) observedEpochs.set(client, epochs = new Map());
    if (!epochs.has(epochKey)) epochs.set(epochKey, registrationEpochs.get(client)?.get(epochKey) ?? 0);
    const enabled = identity.active && props.context === "agent" && props.agentId === identity.agentId;
    const query = useQuery({
      queryKey: [...key, epochs.get(epochKey)],
      queryFn: async ({ signal }) => {
        // Reading the signal lets Query cancel observation on unmount/identity changes;
        // the transport may complete later, but that result cannot publish to this registration.
        if (signal.aborted) throw new Error("balance observation cancelled");
        return rpc({ agent: identity.agentId, refresh: false });
      },
      enabled,
      refetchInterval: 15_000,
      staleTime: 1000,
      gcTime: 0,
      retry: false,
    });
    useEffect(() => {
      if (!enabled) return;
      const token = Symbol();
      leases.add(token);
      diagnostic.mount(1);
      return () => {
        leases.delete(token);
        diagnostic.mount(-1);
        if (snapshot.active && leases.size === 0) publish(null, "pending");
      };
    }, [enabled]);
    const state: PillBalanceState = query.isError ? "error" : query.data === undefined ? "pending"
      : formatBalance(query.data) === null ? "empty" : "success";
    useEffect(() => {
      if (!enabled || snapshot !== identity || leases.size === 0) return;
      diagnostic.query(state, query.isFetching);
      // Errors hide stale data; loading shows a placeholder; successful refetch retains data.
      publish(state === "error" ? null : query.data ?? null, state);
    }, [identity, enabled, query.data, state, query.isFetching]);
    return <HostIcon name="Gauge" size={props.size} color={props.color} />;
  }

  return {
    Icon: BalanceIcon,
    setIdentity(next: PillBalanceIdentity) {
      if (!snapshot.active || (next.agentId === snapshot.agentId && next.provider === snapshot.provider
        && next.sessionId === snapshot.sessionId && next.model === snapshot.model)) return;
      snapshot = { ...next, generation: snapshot.generation + 1, active: true };
      publish(null, "pending");
      notify();
    },
    dispose() {
      if (!snapshot.active) return;
      for (const [client, observed] of observedEpochs) {
        let epochs = registrationEpochs.get(client);
        if (!epochs) registrationEpochs.set(client, epochs = new Map());
        for (const [key, epoch] of observed) {
          epochs.set(key, Math.max(epochs.get(key) ?? 0, epoch + 1));
        }
      }
      snapshot = { ...snapshot, active: false };
      leases.clear();
      notify();
    },
  };
}
