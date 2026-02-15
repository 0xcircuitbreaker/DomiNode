cmake_minimum_required(VERSION 3.14)
project(dominusnode-cpp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(CURL REQUIRED)
find_package(nlohmann_json 3.11 REQUIRED)

add_library(dominusnode
  src/client.cpp
  src/http_client.cpp
  src/token_manager.cpp
  src/auth.cpp
  src/keys.cpp
  src/wallet.cpp
  src/usage.cpp
  src/plans.cpp
  src/sessions.cpp
  src/proxy.cpp
  src/admin.cpp
)

target_include_directories(dominusnode PUBLIC include)
target_link_libraries(dominusnode PUBLIC CURL::libcurl nlohmann_json::nlohmann_json)

# Tests
enable_testing()
add_executable(dominusnode_tests
  tests/test_main.cpp
  tests/test_client.cpp
  tests/test_errors.cpp
  tests/test_proxy.cpp
  tests/test_token_manager.cpp
)
target_link_libraries(dominusnode_tests PRIVATE dominusnode)
add_test(NAME dominusnode_tests COMMAND dominusnode_tests)
