#include "dominusnode/wallet_auth.hpp"
#include "dominusnode/http_client.hpp"
#include "dominusnode/token_manager.hpp"

#include <stdexcept>

namespace dominusnode {

static void validate_eth_address(const std::string& address) {
    if (address.empty()) {
        throw std::invalid_argument("address is required");
    }
    // R45 M-3: String-based validation instead of std::regex for thread safety + performance
    if (address.size() != 42 || address[0] != '0' || address[1] != 'x') {
        throw std::invalid_argument(
            "address must be a valid Ethereum address (0x followed by 40 hex characters)");
    }
    for (size_t i = 2; i < 42; ++i) {
        char c = address[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            throw std::invalid_argument(
                "address must be a valid Ethereum address (0x followed by 40 hex characters)");
        }
    }
}

// R45 H-2: Validate EIP-191 signature format (0x + 130 hex chars = 65 bytes)
static void validate_signature(const std::string& signature) {
    if (signature.empty()) {
        throw std::invalid_argument(
            "signature is required and must be a non-empty string");
    }
    // R45 H-3: Max length check
    if (signature.size() > 200) {
        throw std::invalid_argument("signature must not exceed 200 characters");
    }
    // R45 H-2: EIP-191 format: exactly 132 chars, starts with 0x, rest is hex
    if (signature.size() != 132 || signature[0] != '0' || signature[1] != 'x') {
        throw std::invalid_argument(
            "signature must be a valid EIP-191 signature (0x followed by 130 hex characters)");
    }
    for (size_t i = 2; i < 132; ++i) {
        char c = signature[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            throw std::invalid_argument(
                "signature must be a valid EIP-191 signature (0x followed by 130 hex characters)");
        }
    }
}

WalletAuthResource::WalletAuthResource(HttpClient& http, TokenManager& token_manager)
    : http_(http), token_manager_(token_manager) {}

WalletChallenge WalletAuthResource::challenge(const std::string& address) {
    validate_eth_address(address);
    nlohmann::json body = {{"address", address}};
    auto resp = http_.post("/api/auth/wallet/challenge", body, false);
    return resp.get<WalletChallenge>();
}

WalletVerifyResult WalletAuthResource::verify(const std::string& address,
                                               const std::string& signature,
                                               const std::string& challenge_str) {
    validate_eth_address(address);
    validate_signature(signature);
    nlohmann::json body = {
        {"address", address},
        {"signature", signature},
    };
    if (!challenge_str.empty()) {
        body["challenge"] = challenge_str;
    }
    auto resp = http_.post("/api/auth/wallet/verify", body, false);
    auto result = resp.get<WalletVerifyResult>();
    // R46 C-1: Detect MFA-required response — don't store tokens, surface to caller
    if (result.mfa_required) {
        return result;
    }
    // R45 H-1: Store tokens after verify (matching Python/Go/Java)
    if (!result.token.empty()) {
        token_manager_.set_tokens(result.token, result.refresh_token);
    }
    return result;
}

WalletLinkResult WalletAuthResource::link(const std::string& address,
                                           const std::string& signature,
                                           const std::string& challenge_str) {
    validate_eth_address(address);
    validate_signature(signature);
    nlohmann::json body = {
        {"address", address},
        {"signature", signature},
    };
    if (!challenge_str.empty()) {
        body["challenge"] = challenge_str;
    }
    auto resp = http_.post("/api/auth/wallet/link", body, true);
    return resp.get<WalletLinkResult>();
}

} // namespace dominusnode
