import type { PaseoApi } from "@getpaseo/client";
import type { PiBalance } from "../shared/balance";
import { loadConfig, matchAccount, providerOf, type Config } from "./balanceConfig";
import { probe } from "./balanceProbe";

const empty: PiBalance = { balance: null, unit: null, total: null };
interface State {
  identity: string;
  admitted: number;
  barrier: number;
  cache?: { at: number; value: PiBalance };
  pending?: Promise<PiBalance>;
  controller?: AbortController;
}

export class BalanceService {
  private config: Promise<Config | null>;
  private states = new Map<string, State>();
  private generations = new Map<string, number>();
  private sequence = 0;
  private stopped = false;

  constructor(config = loadConfig()) { this.config = config.catch(() => null); }
  clear(id: string): void {
    this.states.get(id)?.controller?.abort();
    this.states.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }
  dispose(): void {
    this.stopped = true;
    for (const state of this.states.values()) state.controller?.abort();
    this.states.clear();
    this.generations.clear();
  }
  async snapshot(id: string, paseo: PaseoApi, refresh = false): Promise<PiBalance> {
    const generation = this.generations.get(id) ?? 0;
    const request = ++this.sequence;
    try {
      const config = await this.config;
      if (!config || this.stopped) return empty;
      const agent = (await paseo.agents.ref(id).refresh())?.agent;
      if (this.stopped || generation !== (this.generations.get(id) ?? 0)) return empty;
      const model = agent?.runtimeInfo?.model ?? agent?.model ?? null;
      const account = matchAccount(config, providerOf(model));
      const identity = JSON.stringify([agent?.persistence?.sessionId ?? agent?.runtimeInfo?.sessionId, agent?.provider, model]);
      let state = this.states.get(id);
      if (state && (request < state.barrier || (request < state.admitted && state.identity !== identity))) return empty;
      if (!state || state.identity !== identity) {
        state?.controller?.abort();
        state = { identity, admitted: request, barrier: request };
        this.states.set(id, state);
      } else state.admitted = Math.max(state.admitted, request);
      if (!agent || agent.provider !== "pi" || !account) return empty;
      if (!refresh && state.cache && Date.now() - state.cache.at < config.cacheMs) return state.cache.value;
      if (!state.pending) {
        const controller = new AbortController();
        state.controller = controller;
        const current = state;
        current.pending = probe(account, config.timeoutMs, controller.signal).then(value => {
          if (this.stopped || this.states.get(id) !== current) return empty;
          current.cache = { at: Date.now(), value };
          return value;
        }).finally(() => { current.pending = undefined; current.controller = undefined; });
      }
      return (await state.pending) ?? empty;
    } catch { return empty; }
  }
}
