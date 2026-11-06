#pragma once

#include <nlohmann/json.hpp>
#include <ostream>
#include <string>

namespace dominusnode {

inline constexpr const char* REDACTED = "[REDACTED]";

/// Overwrite a string's bytes with zeros (not optimised away), then clear it.
void secure_zero_string(std::string& s) noexcept;

/// A credential returned exactly once by the server (new API key, team key, dn_node_ key).
/// Printing (operator<<, to_string) and JSON serialisation yield "[REDACTED]"; call reveal().
/// The value is zeroized on destruction.
class Secret {
public:
    Secret() = default;
    explicit Secret(std::string value) : value_(std::move(value)) {}
    Secret(const Secret&) = default;
    Secret(Secret&&) noexcept = default;
    Secret& operator=(const Secret& o) { if (this != &o) { secure_zero_string(value_); value_ = o.value_; } return *this; }
    Secret& operator=(Secret&& o) noexcept { if (this != &o) { secure_zero_string(value_); value_ = std::move(o.value_); } return *this; }
    ~Secret() { secure_zero_string(value_); }

    const std::string& reveal() const noexcept { return value_; }
    /// First 8 characters, safe for logs.
    std::string prefix() const { return value_.substr(0, 8); }
    std::string to_string() const { return REDACTED; }

private:
    std::string value_;
};

inline std::ostream& operator<<(std::ostream& os, const Secret&) { return os << REDACTED; }
inline void to_json(nlohmann::json& j, const Secret&) { j = REDACTED; }

} // namespace dominusnode
