/**
 * The Fibonacci-ish planning-poker deck. Order here is the canonical render order.
 * `?` = "no idea", `☕` = "I need a break" — both are non-numeric and excluded from stats.
 */
export const DECK = [0, 1, 2, 3, 5, 8, 13, 21, "?", "☕"] as const;

export type CardValue = (typeof DECK)[number];

/** The numeric members of the deck (excludes `?` and `☕`). */
export type NumericCard = Extract<CardValue, number>;

/** Numeric subset of the deck, used for stats. */
export const NUMERIC_CARDS: readonly NumericCard[] = DECK.filter(
  (c): c is NumericCard => typeof c === "number",
);

/** Narrowing guard: only the numeric cards participate in min/max/avg. */
export function isNumericCard(value: CardValue): value is NumericCard {
  return typeof value === "number";
}

/** Runtime membership check for an untrusted value. */
export function isValidCard(value: unknown): value is CardValue {
  return (DECK as readonly unknown[]).includes(value);
}
