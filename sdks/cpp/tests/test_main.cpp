#include <cstdio>
#include <cstdlib>

// Defined in each test file
extern int run_client_tests();
extern int run_error_tests();
extern int run_proxy_tests();
extern int run_token_manager_tests();

int main() {
    std::printf("=== Dominus Node C++ SDK Test Suite ===\n\n");

    int failures = 0;
    failures += run_client_tests();
    failures += run_error_tests();
    failures += run_proxy_tests();
    failures += run_token_manager_tests();

    std::printf("=== Summary ===\n");
    if (failures == 0) {
        std::printf("All tests passed.\n");
    } else {
        std::printf("%d test(s) FAILED.\n", failures);
    }

    return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
