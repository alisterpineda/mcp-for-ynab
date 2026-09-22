import { z } from "zod";
import { searchable } from "../format/text.js";
import { ToolError, type Report, type ToolContext } from "./envelope.js";
import { BY_ID_OR_NAME, resolveFilters, type EntityLabel } from "./filters.js";

/** A bucket as the caller wrote it: a name, and the categories and groups it gathers. */
export interface BucketInput {
  name: string;
  categories?: string[];
  groups?: string[];
}

/** A bucket once its names are ids, labelled the way the response echoes them. */
export interface Bucket {
  name: string;
  categories: EntityLabel[];
  groups: EntityLabel[];
}

/** The rows split by bucket, and those no bucket claims. */
export interface Partition<T> {
  /** One list per bucket, in the order the buckets were given. */
  assigned: T[][];
  /** The rows no bucket claims: a category nobody named, Uncategorized, a deleted category. */
  unassigned: T[];
}

/** The caller's buckets, resolved, and the rows that fell into each. */
export interface Bucketing {
  buckets: Bucket[];
  /** Sort per-category rows into the buckets. A row's `key` is its category id, null when it has none. */
  partition<T extends { key: string | null }>(rows: T[]): Partition<T>;
}

/**
 * The rules every `buckets` parameter shares, worded once. Each tool wraps them in its own account
 * of what a bucket becomes — a row, a series — and where the unclaimed spending goes; the wording
 * lives on the parameter because a tool description has to fit in 2,048 characters and a
 * parameter's does not.
 */
export const BUCKET_RULES = `A category named directly stays in its bucket even when another bucket names its group, which is how a group is split. A category or group named by two buckets is an error, as is a bucket naming nothing or two buckets with the same name. Each bucket echoes what its \`categories\` and \`groups\` resolved to.`;

/** What no bucket claims, worded once; each tool finishes the sentence with where it goes. */
export const UNCLAIMED = "Spending in no bucket — a category nobody named, Uncategorized, a deleted category —";

/** What a bucket's `groups` and `categories` resolved to, leaving out a kind it did not name. */
export function bucketEcho(bucket: Bucket): Report {
  const echo: Report = {};
  if (bucket.groups.length > 0) echo.groups = bucket.groups;
  if (bucket.categories.length > 0) echo.categories = bucket.categories;
  return echo;
}

/** The `buckets` parameter, described by the tool that takes it. */
export function bucketsParameter(description: string) {
  return z
    .array(
      z.object({
        name: z.string().describe("The bucket's name, as the response shows it."),
        categories: z.array(z.string()).optional().describe(`Categories in this bucket. ${BY_ID_OR_NAME}`),
        groups: z
          .array(z.string())
          .optional()
          .describe(`Category groups whose categories are in this bucket, except a category another bucket names directly. ${BY_ID_OR_NAME}`),
      }),
    )
    .optional()
    .describe(description);
}

/**
 * Resolve the caller's buckets and fix the rule that puts a category in one: its own bucket if a
 * bucket names it, else the bucket that names its group, else none. Every category therefore
 * lands in at most one bucket, which is what lets the rows and `unassigned` add up to the total;
 * a name claimed twice at the same level is refused rather than settled by order, since either
 * choice would move money silently.
 */
export function resolveBuckets(context: ToolContext, inputs: BucketInput[]): Bucketing {
  const buckets: Bucket[] = [];
  const names = new Map<string, string>();
  const byCategory = new Map<string, number>();
  const byGroup = new Map<string, number>();
  const internal = context.db.internalCategoryIds(context.budget.id);

  for (const input of inputs) {
    const name = input.name.trim();
    if (name === "") throw new ToolError("Every bucket needs a name.");
    // Not `fold`: it drops emoji, and "🍔 Food" and "🛒 Food" are two rows a person tells apart.
    const key = searchable(name).replace(/\s+/g, " ");
    const clash = names.get(key);
    if (clash !== undefined) throw new ToolError(`Two buckets are called "${clash}"; give each its own name.`);
    names.set(key, name);

    const [categories, groups] = [input.categories ?? [], input.groups ?? []];
    if (categories.length + groups.length === 0) throw new ToolError(`Bucket "${name}" names no categories or groups.`);
    let echo;
    try {
      echo = resolveFilters(context, { categories, groups }).echo;
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(`In bucket "${name}": ${error.message}`);
      throw error;
    }

    const bucket: Bucket = { name, categories: echo?.categories ?? [], groups: echo?.groups ?? [] };
    // A spending line never carries YNAB's own `Uncategorized` (an uncategorized line has no category
    // at all), so a bucket naming it would echo it as a member and still stay empty.
    const own = bucket.categories.find((label) => internal.has(label.id));
    if (own) {
      throw new ToolError(
        `In bucket "${name}": ${own.name} (${own.id}) is YNAB's own category, which no spending line carries; uncategorized spending always goes to \`unassigned\`.`,
      );
    }
    const index = buckets.length;
    claim(byCategory, bucket.categories, index, buckets, name, "category");
    claim(byGroup, bucket.groups, index, buckets, name, "category group");
    buckets.push(bucket);
  }

  const groupOf = context.db.categoryGroupIds(context.budget.id);
  const bucketOf = (categoryId: string | null): number | null => {
    if (categoryId === null) return null;
    const direct = byCategory.get(categoryId);
    if (direct !== undefined) return direct;
    const group = groupOf.get(categoryId);
    return group === undefined ? null : (byGroup.get(group) ?? null);
  };

  return {
    buckets,
    partition<T extends { key: string | null }>(rows: T[]): Partition<T> {
      const assigned: T[][] = buckets.map(() => []);
      const unassigned: T[] = [];
      for (const row of rows) {
        const index = bucketOf(row.key);
        if (index === null) unassigned.push(row);
        else assigned[index].push(row);
      }
      return { assigned, unassigned };
    },
  };
}

/** Record which bucket names each entity, refusing one that an earlier bucket already named. */
function claim(
  owners: Map<string, number>,
  labels: EntityLabel[],
  index: number,
  earlier: Bucket[],
  name: string,
  kind: string,
): void {
  for (const label of labels) {
    const owner = owners.get(label.id);
    // The same bucket naming something twice ("Groceries" and its id) is still one claim.
    if (owner !== undefined && owner !== index) {
      throw new ToolError(
        `The ${kind} ${label.name} (${label.id}) is in both "${earlier[owner].name}" and "${name}"; name it in one bucket only.`,
      );
    }
    owners.set(label.id, index);
  }
}
