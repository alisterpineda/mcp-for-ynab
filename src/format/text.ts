// Emoji, in the ranges YNAB names actually use: pictographs, skin-tone modifiers, flag halves,
// and the joiners and variation selectors that glue them together (ZWJ U+200D and the two
// variation selectors, written as escapes so they cannot be lost to an invisible edit).
// `\p{Emoji_Component}` is deliberately not used — it includes the ASCII digits.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu;
const DIACRITIC = /\p{Diacritic}/gu;

/**
 * The comparable form of a budget name: emoji dropped, accents folded, lower-cased, whitespace
 * collapsed. Used both for matching a search term and for ordering, so "🥘 Food" sorts under F
 * rather than wherever its emoji happens to fall in code-point order.
 */
export function fold(value: string): string {
  return value.normalize("NFD").replace(DIACRITIC, "").replace(EMOJI, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The looser form a substring search compares: accents folded and lower-cased, nothing dropped.
 * Unlike `fold` it keeps emoji and spacing, because a search for "🎁" is asking for the emoji
 * itself, where a name match only wants the words.
 */
export function searchable(value: string): string {
  return value.normalize("NFD").replace(DIACRITIC, "").toLowerCase();
}

/** Orders by the folded name, with the raw name breaking ties so the order is total. */
export function byName<T>(name: (item: T) => string): (a: T, b: T) => number {
  return (a, bb) => {
    const left = name(a);
    const right = name(bb);
    const folded = fold(left).localeCompare(fold(right));
    return folded !== 0 ? folded : left.localeCompare(right);
  };
}
