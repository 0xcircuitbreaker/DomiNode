### dominusnode_fetch
Fetch a public URL through the DominusNode relay network (GET or HEAD only, ports 80/443, no redirects followed, 10 MB cap, private/internal targets refused). Billed per GB at the live price for the exit IP class (see network_pricing). http:// targets need allow_http=true and are visible to the exit node.

args:
- url (string, required): https:// URL (or http:// with allow_http).
- method (string, optional): HTTP method. one of: GET, HEAD.
- country (string, optional): ISO 3166-1 alpha-2 exit country, e.g. US. Sanctioned countries are refused.
- ip_class (string, optional): Exit IP class. Each class has its own per-GB price (see network_pricing); masked = cheapest, VPN/anonymizer exits, opt-in. one of: residential, dc, mobile, masked.
- session_id (string, optional): Sticky session id (1-64 alphanumeric) to keep the same exit IP.
- allow_http (boolean, optional): Opt in to plaintext http:// targets. Plaintext is visible to the exit node; prefer https.
usage:
~~~json
{
    "thoughts": [
        "I should use dominusnode_fetch."
    ],
    "headline": "Fetch a public URL through the DominusNode relay network (GET or HEAD only, port",
    "tool_name": "dominusnode_fetch",
    "tool_args": {
        "url": "https://example.com"
    }
}
~~~
