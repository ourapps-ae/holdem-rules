// The card-deck surface that hand ranking reads: two-character codes, rank then suit.
// Rank index 0 is a two, 12 an ace; suit index follows `suits`.
export type Card = string;

export type CardCodes = {
  ranks: string;
  suits: string;
  rankNames: readonly string[];
  rankPlurals: readonly string[];
  rankOf(card: Card): number;
  suitOf(card: Card): number;
  fullDeck(): Card[];
};

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export const RANK_NAMES = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"] as const;
export const RANK_PLURALS = ["twos", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens", "jacks", "queens", "kings", "aces"] as const;

// The standard fifty-two card codes, used when no other card-deck is connected.
export const standardCodes: CardCodes = {
  ranks: RANKS,
  suits: SUITS,
  rankNames: RANK_NAMES,
  rankPlurals: RANK_PLURALS,
  rankOf: (card) => RANKS.indexOf(card[0]),
  suitOf: (card) => SUITS.indexOf(card[1]),
  fullDeck() {
    const deck: Card[] = [];
    for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) deck.push(RANKS[r] + SUITS[s]);
    return deck;
  },
};
