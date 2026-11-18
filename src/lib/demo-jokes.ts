/**
 * The Joke API's jokes (Cosign's demo of an agent buying API access over x402). Server-only.
 *
 * JOKES[0] is the joke of the day: each new key's first call gets it, so a demo take is predictable; later calls with
 * the same key go through the rest in order. Original one-liners about crypto, agents and tech; the Jensen Huang ones
 * stick to his public image (the leather jacket, "the more you buy, the more you save").
 */
import { issueKey, keyOf } from "./demo-api-keys";

export type Joke = { joke: string; emoji: string };

export const JOKES: Joke[] = [
  // Simon's pick for the video (2026-11-16): a classic crypto one-liner
  { emoji: "📉", joke: "How do you end up with $1 million in Bitcoin? Put in $10 million." },
  { emoji: "🛋️", joke: "Why did the stablecoin go to therapy? Everyone kept asking it to stay the same." },
  { emoji: "🔑", joke: "Not your keys, not your coins. Not your seed phrase, not your weekend." },
  { emoji: "🧠", joke: "Why does Jensen Huang never lose an argument? He always has more compute." },
  { emoji: "🛒", joke: "Jensen Huang's new diet plan: the more you buy, the more you save." },
  { emoji: "🧥", joke: "Jensen Huang doesn't check the weather. The weather checks his leather jacket." },
];

const g = globalThis as unknown as { __cosignJokeCalls?: Map<string, number> };
const calls: Map<string, number> = (g.__cosignJokeCalls ??= new Map<string, number>());

/** The next joke for this key: the joke of the day first, then the rest in order. */
export function nextJoke(key: string): Joke & { of_the_day: boolean } {
  const n = calls.get(key) ?? 0;
  calls.set(key, n + 1);
  return { ...JOKES[n % JOKES.length], of_the_day: n % JOKES.length === 0 };
}

/** A Joke API key (call after the x402 payment settled). */
export const issueJokeKey = (now = Date.now()) => issueKey("joke", "jk", now);
/** The Joke API key a request carries, if valid. */
export const jokeKeyOf = (req: Request, now = Date.now()) => keyOf(req, "joke", now);
