import { expect, test, vi } from "vitest";
import { createPillBalanceDiagnostic, getPillBalanceDiagnostic, subscribePillBalanceDiagnostic, formatPillBalanceDiagnostic } from "./pillBalanceDiagnostics";

test("component diagnostics publish immutable minimal state and isolate agents", () => {
  const a = createPillBalanceDiagnostic("a");
  const b = createPillBalanceDiagnostic("b");
  const observed = vi.fn();
  const unsubscribe = subscribePillBalanceDiagnostic("a", observed);
  const initial = getPillBalanceDiagnostic("a");
  a.mount(1);
  a.query("pending", true);
  a.publish("success", true);
  expect(initial?.mounted).toBe(0);
  expect(Object.isFrozen(getPillBalanceDiagnostic("a"))).toBe(true);
  expect(getPillBalanceDiagnostic("a")).toMatchObject({ mounted: 1, fetching: true, state: "success", publications: 1 });
  expect(getPillBalanceDiagnostic("b")).toMatchObject({ mounted: 0, publications: 0 });
  expect(formatPillBalanceDiagnostic(getPillBalanceDiagnostic("a")!)).toContain("diag-v7-query-icon");
  a.mount(-1);
  expect(getPillBalanceDiagnostic("a")?.mounted).toBe(0);
  unsubscribe();
  a.dispose(); b.dispose();
});

test("removed and replaced diagnostic handles cannot publish into a new registration", () => {
  const old = createPillBalanceDiagnostic("a");
  const current = createPillBalanceDiagnostic("a");
  const snapshot = getPillBalanceDiagnostic("a");
  old.publish("success", true); old.mount(1); old.dispose();
  expect(getPillBalanceDiagnostic("a")).toBe(snapshot);
  current.dispose();
  current.query("error", false);
  expect(getPillBalanceDiagnostic("a")).toBeNull();
});

test("throwing diagnostic observers cannot interrupt component publication", () => {
  const handle = createPillBalanceDiagnostic("a");
  const unsubscribe = subscribePillBalanceDiagnostic("a", () => { throw new Error("private observer"); });
  expect(() => handle.publish("error", false)).not.toThrow();
  const text = JSON.stringify(getPillBalanceDiagnostic("a"));
  expect(text).not.toContain("private observer");
  expect(text).not.toContain("deadline");
  unsubscribe(); handle.dispose();
});
