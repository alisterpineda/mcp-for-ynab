import { NameResolutionError, type EntityNames, type ResolvedEntities } from "../cache/db.js";
import { ToolError, type ToolContext } from "./envelope.js";

/**
 * Turn the names or ids a user said into the id lists the spending queries filter on. The resolver
 * already writes its failures for a person to read — "No category named X", or the list of
 * candidates when a name is ambiguous — so this only changes who catches them: a `ToolError` comes
 * back as an `isError` result with that same message, which is what Claude needs to retry precisely.
 */
export function resolveFilters(context: ToolContext, names: EntityNames): ResolvedEntities {
  const asked: EntityNames = {};
  // An empty list constrains nothing, so it is not worth resolving or reporting on.
  for (const kind of ["categories", "groups", "payees", "accounts"] as const) {
    const values = names[kind];
    if (values && values.length > 0) asked[kind] = values;
  }

  try {
    return context.db.resolveEntities(context.budget.id, asked);
  } catch (error) {
    if (error instanceof NameResolutionError) throw new ToolError(error.message);
    throw error;
  }
}
