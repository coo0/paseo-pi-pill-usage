import type { PiBalance } from "./balance";

export function formatBalance(value: PiBalance | null): string | null {
  if (value?.balance === null || value === null || !Number.isFinite(value.balance) || !value.unit?.trim()) return null;
  const unit = value.unit.trim().toUpperCase();
  const symbol = unit === "USD" ? "$" : unit === "RMB" || unit === "CNY" ? "￥" : `${value.unit.trim()} `;
  return `${symbol}${value.balance.toFixed(2)}`;
}
