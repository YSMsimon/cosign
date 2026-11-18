import { sellKey } from "@/lib/x402/key-shop";

// The Joke API's key shop: an API key sold over x402 (see lib/x402/key-shop.ts).
const sell = (req: Request) => sellKey(req, { api: "joke", prefix: "jk", name: "Joke API", dataPath: "/api/sellers/joke-api/joke" });

export const GET = sell;
export const POST = sell;
