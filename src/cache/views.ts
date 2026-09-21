import type { CacheData } from "./schema.js";
import type { ClearedStatus } from "../ynab/types.js";

/**
 * One spending line. A plain transaction is one line; a split transaction is expanded into one
 * line per subtransaction (the parent's payee/memo fill in where the split leaves them blank).
 */
export interface TransactionLine {
  id: string;
  /** Set on lines that came from a split; the parent transaction's id. */
  parentId: string | null;
  date: string;
  amount: number;
  accountId: string;
  accountName: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  memo: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flagColor: string | null;
  transferAccountId: string | null;
}

export function flattenTransactions(cache: CacheData): TransactionLine[] {
  const subsByParent = new Map<string, CacheData["subtransactions"][string][]>();
  for (const sub of Object.values(cache.subtransactions)) {
    const list = subsByParent.get(sub.transaction_id);
    if (list) list.push(sub);
    else subsByParent.set(sub.transaction_id, [sub]);
  }

  const lines: TransactionLine[] = [];
  for (const t of Object.values(cache.transactions)) {
    const account = cache.accounts[t.account_id];
    const base = {
      date: t.date,
      accountId: t.account_id,
      accountName: account?.name ?? "(unknown account)",
      cleared: t.cleared,
      approved: t.approved,
      flagColor: t.flag_color ?? null,
    };
    const subs = subsByParent.get(t.id);
    if (!subs || subs.length === 0) {
      lines.push({
        ...base,
        id: t.id,
        parentId: null,
        amount: t.amount,
        memo: t.memo ?? null,
        transferAccountId: t.transfer_account_id ?? null,
        ...payeeFields(cache, t.payee_id ?? null),
        ...categoryFields(cache, t.category_id ?? null),
      });
      continue;
    }
    for (const sub of subs) {
      lines.push({
        ...base,
        id: sub.id,
        parentId: t.id,
        amount: sub.amount,
        memo: sub.memo ?? t.memo ?? null,
        transferAccountId: sub.transfer_account_id ?? null,
        ...payeeFields(cache, sub.payee_id ?? t.payee_id ?? null),
        ...categoryFields(cache, sub.category_id ?? null),
      });
    }
  }
  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return lines;
}

function payeeFields(cache: CacheData, payeeId: string | null) {
  return { payeeId, payeeName: payeeId ? (cache.payees[payeeId]?.name ?? null) : null };
}

function categoryFields(cache: CacheData, categoryId: string | null) {
  const category = categoryId ? cache.categories[categoryId] : undefined;
  const group = category ? cache.categoryGroups[category.category_group_id] : undefined;
  return {
    categoryId,
    categoryName: category?.name ?? null,
    categoryGroupName: group?.name ?? category?.category_group_name ?? null,
  };
}

export interface DateRange {
  earliest: string;
  latest: string;
}

export function transactionDateRange(cache: CacheData): DateRange | null {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const t of Object.values(cache.transactions)) {
    if (earliest === null || t.date < earliest) earliest = t.date;
    if (latest === null || t.date > latest) latest = t.date;
  }
  return earliest && latest ? { earliest, latest } : null;
}
