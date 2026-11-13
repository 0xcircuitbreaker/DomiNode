#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

namespace dominusnode {

/// Caller-supplied EIP-191 signer. The SDK has no crypto dependency for signing;
/// sign_message MUST perform personal_sign over the exact UTF-8 string and return
/// a 0x + 130 hex signature.
struct Signer {
    std::string address;
    std::function<std::string(const std::string& message)> sign_message;
};

/// Validate the signer (address format + callback present). ValidationError otherwise.
const Signer& assert_signer(const Signer& signer, const std::string& name = "signer");
/// Call the signer and validate the returned signature format; failures raise ProtocolError.
std::string sign_with(const Signer& signer, const std::string& message, const std::string& name = "signer");

// ─── Byte-exact signed-message builders (lines joined with '\n', no trailing newline) ───

std::string build_attestation_message(const std::string& wallet, const std::string& nonce,
                                      long long attestation_version, const std::string& attestation_text,
                                      const std::optional<std::string>& node_pubkey);
std::string build_payout_wallet_message(const std::string& user_id, const std::string& wallet,
                                        const std::string& address, const std::string& chain,
                                        const std::string& nonce);
std::string build_withdraw_message(const std::string& user_id, const std::string& wallet,
                                   const std::string& amount_musd, const std::string& idempotency_key,
                                   const std::string& nonce);
std::string build_convert_message(const std::string& user_id, const std::string& wallet,
                                  const std::string& amount_musd, const std::string& idempotency_key,
                                  const std::string& nonce);
/// Line 3 "User: <uuid>" of a server message; ProtocolError if absent or not a UUID.
std::string extract_user_id(const std::string& message);
/// ProtocolError unless server == local (exact).
void assert_same_message(const std::string& server, const std::string& local, const std::string& what);

/// Smallest decimal n >= 0 with sha256(prefix + n) having >= difficulty leading zero bits.
std::string solve_pow(const std::string& prefix, long long difficulty, std::uint64_t max_iterations = 200000000ULL);
/// Leading zero bits of sha256(input).
int sha256_leading_zero_bits(const std::string& input);

} // namespace dominusnode
