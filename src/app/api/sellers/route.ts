// Free index of the demo paid APIs, so an agent that is allowed "<host>/api/sellers" can find them.
export function GET(req: Request) {
  const base = `${new URL(req.url).origin}/api/sellers`;
  return Response.json({
    services: [
      { name: "Bill reader", url: `${base}/bill-reader?bill=<number>`, priceUsd: "0.01", returns: "vendor, amountUsd, due, memo", bills: ["118", "121", "161"] },
      { name: "Vendor check", url: `${base}/vendor-check?address=<0x address>`, priceUsd: "0.02", returns: "knownContact, lookalikeOf, risk (low | high | unknown)" },
    ],
    payment: "x402 on Arc testnet: the first call answers 402; paid_fetch pays and retries.",
  });
}
