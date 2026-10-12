import type { Account } from "./balanceConfig";

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(part)) return undefined;
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function probe(account: Account, timeout: number, signal?: AbortSignal): Promise<{ balance: number | null; unit: string | null; total: number | null }> {
  const render = (value: string) => value.replaceAll("{{baseUrl}}", account.baseUrl.replace(/\/$/, "")).replaceAll("{{apiKey}}", account.apiKey);
  const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const url = new URL(render(account.probe.url));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return { balance: null, unit: null, total: null };
    const response = await fetch(url, { method: account.probe.method, headers: Object.fromEntries(Object.entries(account.probe.headers).map(([key, value]) => [key, render(value)])), redirect: "error", signal: controller.signal });
    if (!response.ok) return { balance: null, unit: null, total: null };
    const body: unknown = await response.json();
    const valid = readPath(body, account.probe.extract.isValid);
    if (valid !== undefined && valid !== true) return { balance: null, unit: null, total: null };
    const value = readPath(body, account.probe.extract.remaining);
    const unit = readPath(body, account.probe.extract.unit);
    const total = readPath(body, account.probe.extract.total);
    return { balance: typeof value === "number" && Number.isFinite(value) ? value : null, unit: typeof unit === "string" ? unit : null, total: typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null };
  } catch { return { balance: null, unit: null, total: null }; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
