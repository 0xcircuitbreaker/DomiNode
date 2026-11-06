#pragma once
// Minimal self-registering test harness + mock transport shared by all test files.

#include "dominusnode/dominusnode.hpp"

#include <deque>
#include <functional>
#include <memory>
#include <optional>
#include <type_traits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace t {

struct Case {
    const char* name;
    void (*fn)();
};
inline std::vector<Case>& registry() {
    static std::vector<Case> r;
    return r;
}
struct Reg {
    Reg(const char* n, void (*f)()) { registry().push_back({n, f}); }
};

[[noreturn]] inline void fail(const std::string& msg, const char* file, int line) {
    throw std::runtime_error(std::string(file) + ":" + std::to_string(line) + ": " + msg);
}

template <class A, class = void>
struct printable : std::false_type {};
template <class A>
struct printable<A, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const A&>())>> : std::true_type {};

template <class A>
std::string show(const A& a) {
    std::ostringstream os;
    if constexpr (std::is_same_v<A, nlohmann::json>) os << a.dump();
    else if constexpr (printable<A>::value) os << a;
    else if constexpr (std::is_same_v<A, std::optional<int>> || std::is_same_v<A, std::optional<std::string>>) {
        if (a) os << *a; else os << "nullopt";
    } else os << "<value>";
    return os.str();
}

}  // namespace t

#define TEST(name)                                     \
    static void name();                                \
    static ::t::Reg reg_##name(#name, name);           \
    static void name()

#define CHECK(c) \
    do { if (!(c)) ::t::fail("CHECK(" #c ")", __FILE__, __LINE__); } while (0)
#define CHECK_EQ(a, b)                                                                                    \
    do {                                                                                                  \
        const auto va_ = (a);                                                                            \
        const auto vb_ = (b);                                                                            \
        if (!(va_ == vb_)) ::t::fail(std::string(#a " == " #b " : ") + ::t::show(va_) + " vs " + ::t::show(vb_), __FILE__, __LINE__); \
    } while (0)
#define CHECK_THROWS(expr, Type)                                                              \
    do {                                                                                      \
        bool thrown_ = false;                                                                 \
        try { (void)(expr); } catch (const Type&) { thrown_ = true; }                         \
        catch (const std::exception& e_) { ::t::fail(std::string("wrong exception: ") + e_.what(), __FILE__, __LINE__); } \
        if (!thrown_) ::t::fail("expected " #Type " from " #expr, __FILE__, __LINE__);       \
    } while (0)
/// ValidationError with code INVALID_ARGUMENT and no status.
#define CHECK_INVALID(expr)                                                                   \
    do {                                                                                      \
        bool thrown_ = false;                                                                 \
        try { (void)(expr); } catch (const dominusnode::ValidationError& e_) {                \
            thrown_ = e_.code() == std::optional<std::string>("INVALID_ARGUMENT") && !e_.status_code(); } \
        if (!thrown_) ::t::fail("expected INVALID_ARGUMENT from " #expr, __FILE__, __LINE__); \
    } while (0)

namespace t {

using json = nlohmann::json;
using namespace dominusnode;

inline const std::string KEY = "dn_live_abcdefghijklmnop";
/// JWT with exp far in the future (payload {"exp":9999999999}).
inline const std::string JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.c2ln";
inline const std::string JWT2 = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.bmV3";
inline const std::string RT = "refresh-token-1";

struct Mock {
    std::vector<HttpRequest> calls;
    std::deque<HttpResponse> queue;

    void push(long status, const json& body = json::object(), std::map<std::string, std::string> headers = {}) {
        queue.push_back({status, std::move(headers), body.is_null() ? "" : body.dump()});
    }
    void push_raw(long status, std::string body, std::map<std::string, std::string> headers = {}) {
        queue.push_back({status, std::move(headers), std::move(body)});
    }
    Transport transport() {
        return [this](const HttpRequest& r) {
            calls.push_back(r);
            if (queue.empty()) return HttpResponse{200, {}, "{}"};
            HttpResponse x = queue.front();
            queue.pop_front();
            return x;
        };
    }
    const HttpRequest& last() const { return calls.back(); }
    static std::string header(const HttpRequest& r, const std::string& name) {
        for (const auto& [k, v] : r.headers) if (k == name) return v;
        return "";
    }
    static bool has_header(const HttpRequest& r, const std::string& name) {
        for (const auto& [k, v] : r.headers) if (k == name) return true;
        return false;
    }
    static json body(const HttpRequest& r) { return r.body ? json::parse(*r.body) : json(); }
    static std::string path(const HttpRequest& r) { return r.url.substr(std::string("https://api.test").size()); }
};

struct Fixture {
    Mock mock;
    std::unique_ptr<DominusNodeClient> client;
    std::vector<long> sleeps;

    /// connected: API key + JWT pair held.
    explicit Fixture(bool connected = true) {
        ClientConfig cfg;
        cfg.base_url = "https://api.test/";
        cfg.transport = mock.transport();
        client = std::make_unique<DominusNodeClient>(cfg);
        client->http().set_sleeper([this](long ms) { sleeps.push_back(ms); });
        if (connected) {
            mock.push(200, {{"valid", true}, {"token", JWT}, {"refreshToken", RT}, {"userId", "u1"}, {"email", "a@b.c"}});
            client->connect_with_key(KEY);
            mock.calls.clear();
        }
    }
};

}  // namespace t
