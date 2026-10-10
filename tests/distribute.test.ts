import test from "node:test";
import assert from "node:assert/strict";
import { distributeRows } from "../sidebar.ts";

test("distributeRows: full fit gives each its need (leftover unused)", () => {
  assert.deepEqual(distributeRows(30, [6, 10, 8]), [6, 10, 8]);
});

test("distributeRows: tight budget sums to available, each <= need", () => {
  const shares = distributeRows(10, [6, 10, 8]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10);
  assert.ok(shares.every((s, i) => s <= [6, 10, 8][i]));
  assert.ok(shares.every(s => Number.isInteger(s) && s >= 0));
});

test("distributeRows: budget smaller than panel count splits one at a time", () => {
  const shares = distributeRows(2, [6, 10, 8]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 2);
  assert.ok(shares.every((s, i) => s <= [6, 10, 8][i]));
});

test("distributeRows: zero available yields all zeros", () => {
  assert.deepEqual(distributeRows(0, [6, 10, 8]), [0, 0, 0]);
});

test("distributeRows: zero-need panels get nothing, others fill", () => {
  const shares = distributeRows(5, [2, 0, 3]);
  assert.deepEqual(shares, [2, 0, 3]);
});

test("distributeRows: sum never exceeds available or total need", () => {
  const needs = [3, 4, 5];
  for (const avail of [0, 1, 3, 6, 12, 50]) {
    const shares = distributeRows(avail, needs);
    const sum = shares.reduce((a, b) => a + b, 0);
    assert.equal(sum, Math.min(avail, 12), `avail=${avail} sum=${sum}`);
    assert.ok(shares.every((s, i) => s <= needs[i]));
  }
});
