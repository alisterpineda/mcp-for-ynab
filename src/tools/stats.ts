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
