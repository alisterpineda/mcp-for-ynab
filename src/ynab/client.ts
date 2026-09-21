import * as ynab from "ynab";
import type { BudgetDetail, BudgetSummary } from "./types.js";

export class YnabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "YnabApiError";
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface RateLimit {
  used: number;
  limit: number;
}

/** The subset of the YNAB API this server uses, expressed as plain results with errors normalised. */
export interface BudgetSource {
  readonly lastRateLimit: RateLimit | null;
  listBudgets(): Promise<{ budgets: BudgetSummary[]; defaultBudget: BudgetSummary | null }>;
  getBudget(budgetId: string, lastKnowledgeOfServer?: number): Promise<{ budget: BudgetDetail; serverKnowledge: number }>;
}

/**
 * Wraps the official `ynab` SDK. Tracks the `X-Rate-Limit` header when present; as of
 * September 2026 the API no longer sends it, so `lastRateLimit` is usually null.
 */
export class YnabClient implements BudgetSource {
  lastRateLimit: RateLimit | null = null;
  private readonly api: ynab.API;

  constructor(token: string) {
    this.api = new ynab.API(token);
  }

  async listBudgets() {
    const data = await this.call(() => this.api.plans.getPlansRaw({}));
    return { budgets: data.data.plans, defaultBudget: data.data.default_plan ?? null };
  }

  /**
   * With `lastKnowledgeOfServer` set, YNAB returns only entities changed since then, with
   * removed ones flagged `deleted: true`. Without it, the whole plan is returned.
   */
  async getBudget(budgetId: string, lastKnowledgeOfServer?: number) {
    const data = await this.call(() => this.api.plans.getPlanByIdRaw({ planId: budgetId, lastKnowledgeOfServer }));
    return { budget: data.data.plan, serverKnowledge: data.data.server_knowledge };
  }

  private async call<T>(request: () => Promise<ynab.ApiResponse<T>>): Promise<T> {
    let response: ynab.ApiResponse<T>;
    try {
      response = await request();
    } catch (error) {
      throw await toApiError(error);
    }
    this.lastRateLimit = parseRateLimit(response.raw.headers.get("x-rate-limit"));
    return response.value();
  }
}

interface YnabErrorBody {
  error?: { id?: string; name?: string; detail?: string };
}

/**
 * YNAB's SDK throws three shapes: the parsed `{ error: { id, name, detail } }` body for a non-2xx
 * response (where `id` is the HTTP status as a string), `FetchError` when the network call itself
 * fails, and `ResponseError` from the generator's runtime for anything else.
 */
async function toApiError(error: unknown): Promise<YnabApiError> {
  if (isYnabErrorBody(error)) {
    const status = Number(error.error?.id) || 0;
    const detail = error.error?.detail ?? error.error?.name ?? "unknown error";
    return new YnabApiError(`YNAB API ${status || "error"}: ${detail}`, status);
  }
  if (error instanceof ynab.ResponseError) {
    const { status, statusText } = error.response;
    let detail = statusText;
    try {
      const body = (await error.response.json()) as YnabErrorBody;
      detail = body.error?.detail ?? body.error?.name ?? detail;
    } catch {
      // Non-JSON error body; keep the HTTP status text.
    }
    return new YnabApiError(`YNAB API ${status}: ${detail}`, status);
  }
  if (error instanceof ynab.FetchError) {
    return new YnabApiError(`Could not reach YNAB: ${error.cause.message}`, 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new YnabApiError(`YNAB request failed: ${message}`, 0);
}

function isYnabErrorBody(value: unknown): value is YnabErrorBody {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as YnabErrorBody).error === "object";
}

function parseRateLimit(header: string | null): RateLimit | null {
  if (!header) return null;
  const match = /^(\d+)\/(\d+)$/.exec(header.trim());
  if (!match) return null;
  return { used: Number(match[1]), limit: Number(match[2]) };
}
