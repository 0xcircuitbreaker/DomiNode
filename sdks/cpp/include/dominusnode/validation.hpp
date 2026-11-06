#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace dominusnode {

/// A µUSD amount input: a digit string ^[1-9][0-9]{0,15}$ or a positive integer. Sent as a decimal string.
class MusdInput {
public:
    MusdInput(long long v) : kind_(v < 0 ? Kind::Bad : Kind::Int), u_(v < 0 ? 0 : static_cast<std::uint64_t>(v)) {}  // NOLINT
    MusdInput(int v) : MusdInput(static_cast<long long>(v)) {}  // NOLINT
    MusdInput(long v) : MusdInput(static_cast<long long>(v)) {}  // NOLINT
    MusdInput(unsigned long long v) : kind_(Kind::Int), u_(v) {}  // NOLINT
    MusdInput(unsigned long v) : kind_(Kind::Int), u_(v) {}  // NOLINT
    MusdInput(std::string s) : kind_(Kind::Str), s_(std::move(s)) {}  // NOLINT
    MusdInput(const char* s) : kind_(Kind::Str), s_(s ? s : "") {}  // NOLINT

    /// Canonical decimal string, enforcing min <= value <= max (ValidationError otherwise).
    std::string normalize(std::uint64_t min, std::uint64_t max, const std::string& name = "amountMusd") const;

private:
    enum class Kind { Int, Str, Bad };
    Kind kind_;
    std::uint64_t u_ = 0;
    std::string s_;
};

bool is_eth_address(const std::string& s);
bool is_uuid(const std::string& s);
bool is_hex64(const std::string& s);

std::string validate_address(const std::string& address, const std::string& name = "address");
std::string validate_signature(const std::string& signature, const std::string& name = "signature");
/// 0 < cents <= 2,147,483,647 (>= 0 when allow_zero).
std::int64_t validate_cents(std::int64_t cents, const std::string& name = "amountCents", bool allow_zero = false);
std::string validate_idempotency_key(const std::string& key);
std::string validate_uuid(const std::string& v, const std::string& name);
std::string validate_non_empty(const std::string& v, const std::string& name, std::size_t max = 256);
long long validate_int_range(long long v, const std::string& name, long long min, long long max);
std::string validate_api_key(const std::string& key);

/// "dn-" + UUIDv4.
std::string new_idempotency_key();
std::string uuid_v4();

/// encodeURIComponent semantics; every user-supplied path parameter goes through this.
std::string url_encode(const std::string& v);

/// Query string builder: omits unset values; "" when empty, else "?k=v&...".
class Query {
public:
    Query& add(const std::string& k, const std::optional<std::string>& v);
    Query& add(const std::string& k, const std::optional<long long>& v);
    Query& add(const std::string& k, const std::optional<int>& v);
    std::string str() const;
private:
    std::vector<std::pair<std::string, std::string>> items_;
};

std::string to_lower(std::string s);
std::string to_upper(std::string s);

} // namespace dominusnode
