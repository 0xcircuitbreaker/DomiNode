// Signer callbacks, byte-exact message builders and the registration PoW.
#include "dominusnode/signing.hpp"
#include "dominusnode/errors.hpp"
#include "dominusnode/validation.hpp"

#include <openssl/sha.h>

#include <exception>

namespace dominusnode {

const Signer& assert_signer(const Signer& signer, const std::string& name) {
    if (!signer.sign_message) throw invalid_arg(name + " must have address and sign_message(message)");
    validate_address(signer.address, name + ".address");
    return signer;
}

std::string sign_with(const Signer& signer, const std::string& message, const std::string& name) {
    std::string sig;
    try {
        sig = signer.sign_message(message);
    } catch (const std::exception& e) {
        throw ProtocolError(name + ".signMessage failed: " + e.what());
    } catch (...) {
        throw ProtocolError(name + ".signMessage failed");
    }
    try {
        return validate_signature(sig, name + " signature");
    } catch (const ValidationError& e) {
        throw ProtocolError(e.what());
    }
}

static std::string join_lines(std::initializer_list<std::string> lines) {
    std::string out;
    bool first = true;
    for (const auto& l : lines) {
        if (!first) out += '\n';
        out += l;
        first = false;
    }
    return out;
}

std::string build_attestation_message(const std::string& wallet, const std::string& nonce,
                                      long long attestation_version, const std::string& attestation_text,
                                      const std::optional<std::string>& node_pubkey) {
    return join_lines({
        "DomiNode node attestation",
        "Version: " + std::to_string(attestation_version),
        "Wallet: " + to_lower(wallet),
        "Nonce: " + nonce,
        "Node pubkey: " + (node_pubkey ? *node_pubkey : std::string("none")),
        "",
        attestation_text,
    });
}

std::string build_payout_wallet_message(const std::string& user_id, const std::string& wallet,
                                        const std::string& address, const std::string& chain,
                                        const std::string& nonce) {
    return join_lines({
        "DominusNode payout wallet",
        "Action: payout_wallet_set",
        "User: " + user_id,
        "Account wallet: " + to_lower(wallet),
        "Payout address: " + to_lower(address),
        "Chain: " + chain,
        "Nonce: " + nonce,
    });
}

std::string build_convert_message(const std::string& user_id, const std::string& wallet,
                                  const std::string& amount_musd, const std::string& idempotency_key,
                                  const std::string& nonce) {
    return join_lines({
        "DominusNode credit conversion",
        "Action: convert",
        "User: " + user_id,
        "Account wallet: " + to_lower(wallet),
        "Amount (\xC2\xB5USD): " + amount_musd,
        "Idempotency key: " + idempotency_key,
        "Nonce: " + nonce,
    });
}

std::string build_withdraw_message(const std::string& user_id, const std::string& wallet,
                                   const std::string& amount_musd, const std::string& idempotency_key,
                                   const std::string& nonce) {
    return join_lines({
        "DominusNode withdrawal",
        "Action: withdraw",
        "User: " + user_id,
        "Account wallet: " + to_lower(wallet),
        "Amount (\xC2\xB5USD): " + amount_musd,
        "Idempotency key: " + idempotency_key,
        "Nonce: " + nonce,
    });
}

std::string extract_user_id(const std::string& message) {
    std::size_t a = message.find('\n');
    std::size_t b = a == std::string::npos ? a : message.find('\n', a + 1);
    std::string line;
    if (b != std::string::npos) {
        std::size_t c = message.find('\n', b + 1);
        line = message.substr(b + 1, c == std::string::npos ? std::string::npos : c - b - 1);
    }
    const std::string pfx = "User: ";
    if (line.rfind(pfx, 0) != 0 || !is_uuid(line.substr(pfx.size()))) {
        throw ProtocolError("challenge message has no valid User line");
    }
    return line.substr(pfx.size());
}

void assert_same_message(const std::string& server, const std::string& local, const std::string& what) {
    if (server != local) {
        throw ProtocolError(what + ": the server's message differs from the one built locally; refusing to sign "
                            "(wrong signer for the linked wallet, mismatched parameters, or protocol change)");
    }
}

int sha256_leading_zero_bits(const std::string& input) {
    unsigned char d[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.data()), input.size(), d);
    int bits = 0;
    for (unsigned char byte : d) {
        if (byte == 0) { bits += 8; continue; }
        for (int i = 7; i >= 0 && !(byte & (1 << i)); --i) ++bits;
        return bits;
    }
    return bits;
}

std::string solve_pow(const std::string& prefix, long long difficulty, std::uint64_t max_iterations) {
    if (prefix.empty() || prefix.size() > 256) throw ProtocolError("invalid PoW prefix");
    if (difficulty < 1 || difficulty > 32) throw ProtocolError("invalid PoW difficulty");
    for (std::uint64_t n = 0; n < max_iterations; ++n) {
        std::string s = std::to_string(n);
        if (sha256_leading_zero_bits(prefix + s) >= difficulty) return s;
    }
    throw ProtocolError("PoW not solved within iteration cap");
}

}  // namespace dominusnode
