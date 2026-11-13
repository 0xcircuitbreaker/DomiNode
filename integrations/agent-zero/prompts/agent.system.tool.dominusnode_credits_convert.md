### dominusnode_credits_convert
Explains how to convert node credits into wallet balance. Conversion needs a wallet signature, so it runs through the DominusNode MCP server or SDK with a signer key file, not through this tool.

args:
- amount_musd (string, required): Amount in micro-USD as a digit string (min 10000 = $0.01).
usage:
~~~json
{
    "thoughts": [
        "I should use dominusnode_credits_convert."
    ],
    "headline": "Explains how to convert node credits into wallet balance",
    "tool_name": "dominusnode_credits_convert",
    "tool_args": {
        "amount_musd": "1000000"
    }
}
~~~
