### dominusnode_topup_crypto
Create a crypto invoice to top up the requester wallet ($10-$1,000). Returns a payment address/URL; the wallet is credited after on-chain confirmation (check with check_payment).

args:
- amount_cents (integer, required): Amount in US cents (1000 = $10).
- currency (string, required): Cryptocurrency to pay with. one of: btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb, link.
usage:
~~~json
{
    "thoughts": [
        "I should use dominusnode_topup_crypto."
    ],
    "headline": "Create a crypto invoice to top up the requester wallet ($10-$1,000)",
    "tool_name": "dominusnode_topup_crypto",
    "tool_args": {
        "amount_cents": 1000,
        "currency": "btc"
    }
}
~~~
