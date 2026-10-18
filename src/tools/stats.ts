import type { Report, ToolContext } from "./envelope.js";

/**
 * The middle value, or the mean of the two middle values: the typical month when a single large
 * month — an annual bill, a trip — would pull the average away from it. Throws on an empty list,
 * which has no median.
 */
export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The four figures every monthly series is summarised by, in the units the values came in. */
export interface Spread {
  average: number;
  median: number;
  min: number;
  max: number;
}

/**
 * How a set of months spreads out: the average, the median beside it (one big month drags the
 * average, not the median), and the lowest and highest. The lowest month is the floor the budget
 * has already lived on once, which is what makes a cut realistic rather than hoped for. Null for
 * an empty list, which has nothing to summarise; the caller leaves the keys out rather than guess.
 */
export function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * The spread of some months in milliunits, rendered as the four keys every tool promises under the
 * same names, or null when there are no months. Statistics are taken in milliunits and rendered
 * once, since an average of rounded months drifts from the months it summarises.
 */
export function renderSpread(context: ToolContext, values: number[]): Report | null {
  const figures = spread(values);
  if (!figures) return null;
  return {
    average: context.money(figures.average),
    median: context.money(figures.median),
    min: context.money(figures.min),
    max: context.money(figures.max),
  };
}
