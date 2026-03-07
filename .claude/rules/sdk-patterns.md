# SDK Patterns

These rules apply when working on any of the 6 SDKs (sdks/node, sdks/python, sdks/rust, sdks/go, sdks/java, sdks/cpp).

## Cross-SDK Requirements

- All SDKs must have matching feature parity (same resources, same methods)
- All SDKs have: AgenticWalletResource, TeamsResource (18 methods incl. revokeKey), WalletAuth
- All SDK HTTP clients: disable auto-redirects, cap response 10MB, zeroize credentials on disconnect
- All SDKs ActiveSession types must NOT include proxy_ip (upstream infra detail)
- SDK 429 retry: cap wait (10s), add +/-10% jitter, enforce 100ms min; CANCEL body stream
- SDK Disconnect() must clear ALL credential fields (API key + tokens + email + password)
- amountCents: validate 0 < amountCents <= 2,147,483,647 client-side in all fund/topUp methods
- URL path params: always URL-encode (Python quote, Go PathEscape, Rust encode_uri_component, C++ url_encode, Java URLEncoder)
- EIP-191 signature validation: 0x + 130 hex = 132 chars, max 200 chars
- Token redaction in all output paths (repr, Debug, String, MarshalJSON, operator<<)
- verify() must detect MFA response (mfaRequired:true) and surface it

## Language-Specific

- **Node.js**: zero deps, dual CJS+ESM, module: "Node16" + moduleResolution: "Node16"; TokenManager.clear() must NOT null refreshFn
- **C++**: explicit TLS verification after curl_easy_reset(); secure_zero_string() on disconnect
- **Rust**: auth.logout() BEFORE token_manager.clear() + zeroize stored api_key
- **Python**: NaN/Infinity guards on numeric inputs
- **Go**: MarshalJSON redaction for sensitive fields
- **Java**: distributionManagement for GitHub Packages in pom.xml
