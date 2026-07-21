# Deploy x402-books as a paid endpoint

The split: **the gateway sells, x402-books computes.** `server/backend.js` speaks no
x402 and holds no keys — it's plain HTTP on localhost. An x402 gateway in front of it
owns the 402 challenge, verify/settle, your wallet, mainnet facilitator auth, TLS, and
discovery. Don't put payment code in this repo; that job is already done and tested.

These instructions use [x402-sandbox](https://github.com/RegardV/x402-sandbox) as the
gateway. Any gateway that can proxy a paid route to an upstream URL works the same way.

## 1. Run the backend

```sh
git clone https://github.com/RegardV/x402-books.git
cd x402-books
PORT=8404 node server/backend.js      # no npm install - zero dependencies
```

Check it:

```sh
curl -s -X POST http://127.0.0.1:8404/report \
  -H 'content-type: application/json' \
  -d '{"wallet":"0xYourSellerWallet","period":"2026-07","jurisdiction":"NONE"}' | head -c 400
```

That's the *unpaid* path — it must stay on `127.0.0.1`. Never expose port 8404
publicly; it has no payment gate by design.

To keep it running across reboots, install the systemd template:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/x402-books-backend.service ~/.config/systemd/user/
# edit the two "CHANGE ME" values (clone path, absolute node path)
systemctl --user daemon-reload
systemctl --user enable --now x402-books-backend
journalctl --user -u x402-books-backend -f
```

## 2. Sell it through the gateway

Merge the two entries from [`deploy/sandbox-products.json`](../deploy/sandbox-products.json)
into your sandbox's `products.json` `products` array, then restart the gateway:

```sh
systemctl --user restart x402-sandbox
```

A restart is required — the sandbox's config file-watch does not reliably pick up new
*routes* after an atomic-rename edit.

You get two products off one backend:

| Route | Buyer | Notes |
|---|---|---|
| `POST /books` | agents | discoverable, listed in x402 registries |
| `GET /books-web` | humans | renders a form (`humanForm`), pays via browser wallet |

Verify both are live:

```sh
curl -s https://your-gateway.example.com/catalog.json | grep -o '"sku":"books[^"]*"'
curl -si -X POST https://your-gateway.example.com/books | head -1   # expect: HTTP/2 402
```

## 3. Going to mainnet

Nothing changes in x402-books — it never sees a network or a key. Switch the *gateway*
to `eip155:8453` with a mainnet-capable facilitator and mainnet receive wallet. Test
on Base Sepolia (`eip155:84532`, free via `x402.org/facilitator`) first.

## Scope limit worth knowing before you charge for this

Pointed at an arbitrary wallet, the output is **unattributed**: the chain records
from/to/amount/timestamp, never *which product* a payment was for. The accounting
numbers (revenue totals, fiat valuation at receipt, journal, tax packs) are all correct
without it — but "revenue by product" only exists in owner mode, where x402-books reads
your own gateway's settlement log via `sandboxDbs` in `books.json`.

So the strongest use of this tool is the **free local CLI on your own data**. The paid
public endpoint is a live demo of the stack and a convenience for someone reporting on a
wallet they don't run.
