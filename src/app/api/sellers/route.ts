// Free index of the demo paid APIs, so an agent that is allowed "<host>/api/sellers" can find them.
export function GET(req: Request) {
  const base = `${new URL(req.url).origin}/api/sellers`;
  return Response.json({
    services: [
      {
        name: "Joke API",
        url: `${base}/joke-api/joke`,
        access: "needs an API key; a call without one answers 401 and says how to get one",
        returns: "joke, emoji",
      },
      {
        name: "Bills API",
        url: `${base}/bills-api/bills/<number>`,
        access: "needs an API key; a call without one answers 401 and says how to get one",
        returns: "vendor, amountUsd, due, memo",
        bills: ["118", "121", "161", "122–160 (Oliver Grant, weekly)"],
      },
      { name: "Vendor check", url: `${base}/vendor-check?address=<0x address>`, priceUsd: "0.02", returns: "knownContact, lookalikeOf, risk (low | high | unknown)" },
    ],
    payment: "x402 on Arc testnet: a paid call first answers 402; paid_fetch pays and retries.",
  });
}
