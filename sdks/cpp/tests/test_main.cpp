#include "test_util.hpp"

#include <cstdio>
#include <cstdlib>

int main() {
    // Local fake servers must not be routed through any ambient HTTP(S)_PROXY.
    setenv("NO_PROXY", "*", 1);
    setenv("no_proxy", "*", 1);
    int passed = 0, failed = 0;
    for (const auto& c : t::registry()) {
        try {
            c.fn();
            ++passed;
        } catch (const std::exception& e) {
            ++failed;
            std::printf("FAIL %s\n  %s\n", c.name, e.what());
        }
    }
    std::printf("%d passed, %d failed, %zu total\n", passed, failed, t::registry().size());
    return failed == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
