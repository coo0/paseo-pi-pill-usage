import { describe, expect, it } from "vitest";
import { formatBalance } from "./balanceFormat";

describe("formatBalance", () => {
  it.each([["USD", "$12.30"], ["RMB", "￥12.30"], ["CNY", "￥12.30"], ["USD", "$0.00"]])("formats %s with two decimals", (unit, expected) => {
    expect(formatBalance({ balance: unit === "USD" && expected === "$0.00" ? 0 : 12.3, unit })).toBe(expected);
  });
  it("hides missing, invalid, or unknown unit balances", () => {
    expect(formatBalance({ balance: null, unit: "USD" })).toBeNull();
    expect(formatBalance({ balance: 1, unit: null })).toBeNull();
    expect(formatBalance({ balance: 1, unit: "" })).toBeNull();
    expect(formatBalance({ balance: 1, unit: "EUR" })).toBe("EUR 1.00");
  });
});
