// Pagination helpers and tolerant byte counts.
#include "dominusnode/resources.hpp"
#include "dominusnode/errors.hpp"

#include <limits>
#include <regex>

namespace dominusnode {

namespace {

constexpr long long kMaxOffset = 1000000;

long long page_size(OptInt limit, long long def, long long max) {
    return validate_int_range(limit.value_or(def), "limit", 1, max);
}

const json* items_of(const json& page, const char* field) {
    if (!page.is_object() || !page.contains(field) || !page[field].is_array()) return nullptr;
    return &page[field];
}

/// Offset pagination. fetch(limit, offset) returns a page; stop on a short page, at pagination.total,
/// or when fn returns false.
template <typename Fetch>
void offset_pages(long long limit, const char* field, bool use_total, const ItemCallback& fn, Fetch fetch) {
    for (long long offset = 0; offset <= kMaxOffset; offset += limit) {
        json page = fetch(limit, offset);
        const json* items = items_of(page, field);
        long long n = items ? static_cast<long long>(items->size()) : 0;
        if (items) {
            for (const auto& item : *items) {
                if (!fn(item)) return;
            }
        }
        if (n < limit) return;
        if (use_total && page.contains("pagination") && page["pagination"].is_object()) {
            const json& t = page["pagination"].value("total", json());
            if (t.is_number_integer() && t.get<long long>() > 0 && offset + n >= t.get<long long>()) return;
        }
    }
}

/// Follows nextCursor when the server sends one; otherwise offset pagination (short page = last).
template <typename ByOffset, typename ByCursor>
void cursor_or_offset_pages(long long limit, const char* field, const ItemCallback& fn, ByOffset by_offset, ByCursor by_cursor) {
    OptStr cursor;
    long long offset = 0;
    for (int pages = 0; offset <= kMaxOffset && pages < 100000; ++pages) {
        json page = cursor ? by_cursor(limit, *cursor) : by_offset(limit, offset);
        const json* items = items_of(page, field);
        long long n = items ? static_cast<long long>(items->size()) : 0;
        if (n == 0) return;
        for (const auto& item : *items) {
            if (!fn(item)) return;
        }
        const json next = page.is_object() ? page.value("nextCursor", json()) : json();
        if (next.is_string()) {
            std::string nc = next.get<std::string>();
            static const std::regex page_cursor_re("^[A-Za-z0-9_=+/.:-]{1,512}$");
            if (!std::regex_match(nc, page_cursor_re) || (cursor && *cursor == nc)) return;
            cursor = nc;
            continue;
        }
        if (cursor || n < limit) return;
        offset += limit;
    }
}

}  // namespace

std::int64_t byte_count(const json& v) {
    if (v.is_null()) return 0;
    if (v.is_number_integer()) {
        if (v.is_number_unsigned() && v.get<std::uint64_t>() > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
            throw ServerError("byte count out of range", 0);
        return v.get<std::int64_t>();
    }
    if (v.is_string()) {
        static const std::regex digits("^-?[0-9]{1,19}$");
        const std::string& s = v.get_ref<const std::string&>();
        if (!std::regex_match(s, digits)) throw ServerError("byte count is not a numeric string", 0);
        try {
            return std::stoll(s);
        } catch (const std::exception&) {
            throw ServerError("byte count out of range", 0);
        }
    }
    throw ServerError("byte count must be a number or numeric string", 0);
}

void CreditsResource::for_each_transaction(const ItemCallback& fn, OptInt limit, OptStr type) {
    static const std::regex cursor_re("^[1-9][0-9]{0,18}$");
    OptStr cursor;
    for (;;) {
        json page = transactions(limit, cursor, type);
        const json* items = items_of(page, "transactions");
        if (!items || items->empty()) return;
        for (const auto& item : *items) {
            if (!fn(item)) return;
        }
        const json next = page.value("nextCursor", json());
        if (!next.is_string()) return;
        std::string nc = next.get<std::string>();
        if (!std::regex_match(nc, cursor_re) || (cursor && *cursor == nc)) return;
        cursor = nc;
    }
}

void PayoutsResource::for_each(const ItemCallback& fn, OptInt limit) {
    cursor_or_offset_pages(page_size(limit, 50, 200), "payouts", fn, [this](long long l, long long o) { return list(l, o); },
                           [this](long long l, const std::string& c) { return list_after(l, c); });
}

void NodesResource::for_each(const ItemCallback& fn, OptInt limit) {
    cursor_or_offset_pages(page_size(limit, 100, 500), "nodes", fn, [this](long long l, long long o) { return list(l, o); },
                           [this](long long l, const std::string& c) { return list_after(l, c); });
}

void UsageResource::for_each_record(const ItemCallback& fn, OptStr from, OptStr to, OptInt limit) {
    offset_pages(page_size(limit, 200, 1000), "records", true, fn,
                 [this, &from, &to](long long l, long long o) { return get(from, to, l, o); });
}

void WalletResource::for_each_transaction(const ItemCallback& fn, OptInt limit) {
    offset_pages(page_size(limit, 50, 100), "transactions", false, fn,
                 [this](long long l, long long o) { return get_transactions(l, o); });
}

}  // namespace dominusnode
