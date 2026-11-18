import { keyRequired } from "@/lib/demo-api-keys";
import { jokeKeyOf, nextJoke } from "@/lib/demo-jokes";

// The Joke API: one joke per call, for callers with a key. Without a key it answers 401 and says where to buy one
// (over x402): the demo of an agent buying API access with no account, paid by nanopayment from its own wallet.

export function GET(req: Request) {
  const key = jokeKeyOf(req);
  if (!key) return keyRequired(`${new URL(req.url).origin}/api/sellers/joke-api`, "Joke API");
  return Response.json(nextJoke(key));
}
