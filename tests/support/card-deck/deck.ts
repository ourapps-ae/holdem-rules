// A deck of playing cards: create, shuffle, deal, burn. Card codes are two characters, rank then suit.
// Rank index 0 is a two, 12 an ace; suit index follows "cdhs". Jokers (optional) are "*r" and "*b".

export type Card = string;

// The part of a random-source this component needs: `shuffle(items)` of a created fair-shuffle source.
export type Shuffler = { shuffle<T>(items: readonly T[]): T[] };

export type DeckSettings = { decks: number; jokers: boolean };

// Cards still to deal (the next card is the last element) and cards burned face down.
export type Deck = { draw: Card[]; burned: Card[] };

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export const JOKER_RANK = "*";
export const JOKER_SUITS = "rb";
export const MAX_DECKS = 8;
export const DEFAULT_SETTINGS: DeckSettings = { decks: 1, jokers: false };

export const RANK_NAMES = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];
export const RANK_PLURALS = ["twos", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens", "jacks", "queens", "kings", "aces"];
export const SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"];

export type ParsedCard = { rank: number; suit: number; joker: boolean };

export function isJoker(card: unknown): boolean {
  return typeof card === "string" && card.length === 2 && card[0] === JOKER_RANK && JOKER_SUITS.includes(card[1]);
}

export function isCard(x: unknown): x is Card {
  if (typeof x !== "string" || x.length !== 2) return false;
  return (RANKS.includes(x[0]) && SUITS.includes(x[1])) || isJoker(x);
}

// Rank index (-1 for a joker or an invalid code).
export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]);
}

// Suit index (-1 for a joker or an invalid code).
export function suitOf(card: Card): number {
  return SUITS.indexOf(card[1]);
}

export function makeCard(rank: number, suit: number): Card {
  if (!Number.isInteger(rank) || rank < 0 || rank > 12 || !Number.isInteger(suit) || suit < 0 || suit > 3) throw new RangeError("rank is 0 to 12 and suit 0 to 3");
  return RANKS[rank] + SUITS[suit];
}

// Null for anything that is not a card code.
export function parseCard(code: unknown): ParsedCard | null {
  if (!isCard(code)) return null;
  if (isJoker(code)) return { rank: -1, suit: -1, joker: true };
  return { rank: rankOf(code), suit: suitOf(code), joker: false };
}

export function isRed(card: Card): boolean {
  return card[1] === "h" || card[1] === "d" || card === "*r";
}

// A readable name such as "ace of spades" or "red joker".
export function cardName(card: Card): string {
  const parsed = parseCard(card);
  if (!parsed) throw new RangeError(`not a card: ${String(card)}`);
  if (parsed.joker) return card[1] === "r" ? "red joker" : "black joker";
  return `${RANK_NAMES[parsed.rank]} of ${SUIT_NAMES[parsed.suit]}`;
}

export function validateSettings(settings: DeckSettings): DeckSettings {
  if (!Number.isInteger(settings.decks) || settings.decks < 1 || settings.decks > MAX_DECKS) throw new RangeError(`decks must be a whole number from 1 to ${MAX_DECKS}`);
  if (typeof settings.jokers !== "boolean") throw new TypeError("jokers must be true or false");
  return { decks: settings.decks, jokers: settings.jokers };
}

// One 52-card pack in suit order (clubs, diamonds, hearts, spades; two to ace), without jokers.
export function fullPack(): Card[] {
  const pack: Card[] = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) pack.push(makeCard(r, s));
  return pack;
}

// An unshuffled deck: `decks` packs, plus two jokers per pack when `jokers` is on.
export function createDeck(settings: DeckSettings = DEFAULT_SETTINGS): Deck {
  const { decks, jokers } = validateSettings(settings);
  const draw: Card[] = [];
  for (let d = 0; d < decks; d++) {
    draw.push(...fullPack());
    if (jokers) draw.push("*r", "*b");
  }
  return { draw, burned: [] };
}

// Shuffle what is left to deal; burned cards stay burned. Returns a new deck.
export function shuffleDeck(deck: Deck, source: Shuffler): Deck {
  return { draw: source.shuffle(deck.draw), burned: [...deck.burned] };
}

// Gather every card back (dealt and burned cards must be returned by the caller), then shuffle.
export function createShuffledDeck(settings: DeckSettings, source: Shuffler): Deck {
  return shuffleDeck(createDeck(settings), source);
}

export function remaining(deck: Deck): number {
  return deck.draw.length;
}

// Take `count` cards from the end of the draw pile; the first card taken is dealt first.
export function deal(deck: Deck, count = 1): { cards: Card[]; deck: Deck } {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a whole number of at least 0");
  if (count > deck.draw.length) throw new RangeError(`cannot deal ${count} from ${deck.draw.length} cards`);
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) cards.push(deck.draw[deck.draw.length - 1 - i]);
  return { cards, deck: { draw: deck.draw.slice(0, deck.draw.length - count), burned: [...deck.burned] } };
}

// Discard `count` cards face down before dealing; they are kept in `burned`.
export function burn(deck: Deck, count = 1): Deck {
  const { cards, deck: rest } = deal(deck, count);
  return { draw: rest.draw, burned: [...rest.burned, ...cards] };
}

// The card-code surface other components read (poker-hand-ranking's `CardCodes`).
export type CardCodes = {
  ranks: string;
  suits: string;
  rankNames: readonly string[];
  rankPlurals: readonly string[];
  rankOf(card: Card): number;
  suitOf(card: Card): number;
  fullDeck(): Card[];
};

export const cardCodes: CardCodes = { ranks: RANKS, suits: SUITS, rankNames: RANK_NAMES, rankPlurals: RANK_PLURALS, rankOf, suitOf, fullDeck: fullPack };
