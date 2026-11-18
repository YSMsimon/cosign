import { sellKey } from "@/lib/x402/key-shop";

// The Bills API's key shop: an API key sold over x402 (see lib/x402/key-shop.ts).
const sell = (req: Request) => sellKey(req, { api: "bills", prefix: "bk", name: "Bills API", dataPath: "/api/sellers/bills-api/bills/<number>" });

export const GET = sell;
export const POST = sell;
