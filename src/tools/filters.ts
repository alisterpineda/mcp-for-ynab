import { NameResolutionError, RESOLVABLE, type EntityNames, type ResolvedEntities } from "../cache/db.js";
import { ToolError, type ToolContext } from "./envelope.js";

/** One resolved entity, as the response names it. */
export interface EntityLabel {
  id: string;
  name: string;
}

/** What a filter list resolved to, in the response's own words: the entities behind the numbers. */
export interface ResolvedFilters {
  ids: ResolvedEntities;
  /** `{ categories: [{ id, name }], ... }` for every list that was given, or undefined when none was. */
  echo?: Partial<Record<keyof EntityNames, EntityLabel[]>>;
}

/**
 * Turn the names or ids a user said into the id lists the spending queries filter on, and into the
 * names to echo back. The resolver accepts a part of a name when only one entity contains it, so
 * the echo is what makes a match visible: "costco" landing on "Costco Gas" is a different answer
 * from the one asked for, and the response has to say so where the numbers are. The resolver
 * already writes its failures for a person to read — "No category named X", or the candidates when
 * a name is ambiguous — so this only changes who catches them: a `ToolError` comes back as an
 * `isError` result with that same message, which is what Claude needs to retry precisely.
 */
export function resolveFilters(context: ToolContext, names: EntityNames): ResolvedFilters {
  const asked: EntityNames = {};
  // An empty list constrains nothing, so it is not worth resolving or reporting on.
  for (const kind of KINDS) {
    const values = names[kind];
    if (values && values.length > 0) asked[kind] = values;
  }

  let ids: ResolvedEntities;
  try {
    ids = context.db.resolveEntities(context.budget.id, asked);
  } catch (error) {
    if (error instanceof NameResolutionError) throw new ToolError(error.message);
    throw error;
  }

  const echo: Partial<Record<keyof EntityNames, EntityLabel[]>> = {};
  for (const kind of KINDS) {
    const resolved = ids[RESOLVABLE[kind].key];
    if (!resolved) continue;
    const labels = context.db.entityLabels(context.budget.id, kind, resolved);
    // Every id came out of the resolver a moment ago, so each has a label; the fallback is for form.
    echo[kind] = resolved.map((id) => ({ id, name: labels.get(id) ?? id }));
  }
  return Object.keys(echo).length > 0 ? { ids, echo } : { ids };
}

/**
 * How every name filter reads what it is given, said on the parameter itself: a tool description
 * has to fit in the 2,048 characters Claude Code passes on, and a parameter's does not.
 */
export const BY_ID_OR_NAME = `By id or name: a whole name first, else a part only one of them contains ("costco" finds "Costco Wholesale"). An ambiguous name is an error listing the candidates.`;

/** The resolver's own kind list, so a kind added there is asked about and echoed here. */
const KINDS = Object.keys(RESOLVABLE) as (keyof EntityNames)[];
