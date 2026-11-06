### dominusnode_proxy_url
Build a relay gateway proxy URL for use in other HTTP clients. Routing flags go in the username (country-XX, class-..., session-..., allowhttp-1). The password is shown as a ${DOMINUSNODE_API_KEY} placeholder: substitute the key from the environment, never paste it into chat.

args:
- country (string, optional): ISO 3166-1 alpha-2 exit country, e.g. US. Sanctioned countries are refused.
- ip_class (string, optional): Exit IP class. Each class has its own per-GB price (see network_pricing). one of: residential, dc, mobile.
- session_id (string, optional): Sticky session id (1-64 alphanumeric) to keep the same exit IP.
- allow_http (boolean, optional): Opt in to plaintext http:// targets. Plaintext is visible to the exit node; prefer https.
- protocol (string, optional): Proxy protocol. one of: http, socks5.
usage:
~~~json
{
    "thoughts": [
        "I should use dominusnode_proxy_url."
    ],
    "headline": "Build a relay gateway proxy URL for use in other HTTP clients",
    "tool_name": "dominusnode_proxy_url",
    "tool_args": {}
}
~~~
