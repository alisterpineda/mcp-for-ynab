import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimalsOf, moneyFormatter } from "../src/format/money.js";

describe("moneyFormatter", () => {
  const two = moneyFormatter(2);

  it("divides milliunits by a thousand", () => {
    assert.equal(two(1_234_560), 1234.56);
    assert.equal(two(10_284_400), 10284.4);
    assert.equal(two(-6_120_550), -6120.55);
    assert.equal(two(0), 0);
  });

  it("rounds half away from zero at the currency's precision", () => {
    assert.equal(two(1_235), 1.24, "a half cent rounds up");
    assert.equal(two(-1_235), -1.24, "and away from zero when negative");
    assert.equal(two(1_234), 1.23);
    assert.equal(two(-1_234), -1.23);
    assert.equal(two(1_236), 1.24);
  });

  it("emits whole numbers for a zero-decimal currency", () => {
    const yen = moneyFormatter(0);
    assert.equal(yen(1_500_000), 1500);
    assert.equal(yen(1_500), 2, "half a unit rounds away from zero");
    assert.equal(yen(-1_500), -2);
    assert.equal(yen(1_499), 1);
    assert.equal(Number.isInteger(yen(1_499)), true);
  });

  it("keeps three-decimal currencies exact", () => {
    const dinar = moneyFormatter(3);
    assert.equal(dinar(1_234), 1.234);
    assert.equal(dinar(-1), -0.001);
  });
});

describe("decimalsOf", () => {
  it("takes the budget's decimal digits", () => {
    assert.equal(decimalsOf({ decimal_digits: 0 } as never), 0);
    assert.equal(decimalsOf({ decimal_digits: 3 } as never), 3);
  });

  it("defaults to two when the budget has no currency format", () => {
    assert.equal(decimalsOf(null), 2);
  });
});
