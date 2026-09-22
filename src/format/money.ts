import type { CurrencyFormat } from "../ynab/types.js";

/** YNAB's own precision for the budget's currency. Two is the fallback when none is cached. */
export function decimalsOf(format: CurrencyFormat | null): number {
  return format?.decimal_digits ?? 2;
}

/**
 * Milliunits to a bare JSON number at the currency's precision, rounding half away from zero.
 * A zero-decimal currency therefore yields integers. The rounding decision is made on integers,
 * so a value exactly on the half never turns on the representation of `milliunits / 1000`.
 */
export function moneyFormatter(decimals: number): (milliunits: number) => number {
  const scale = 10 ** decimals;
  return (milliunits) => {
    const scaled = Math.abs(milliunits) * scale;
    const whole = Math.floor(scaled / 1000);
    const remainder = scaled - whole * 1000;
    const rounded = remainder >= 500 ? whole + 1 : whole;
    return (milliunits < 0 ? -rounded : rounded) / scale;
  };
}
