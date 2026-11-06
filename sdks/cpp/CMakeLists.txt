cmake_minimum_required(VERSION 3.14)
project(dominusnode-cpp VERSION 2.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(CURL 7.85 REQUIRED)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

add_library(dominusnode
  src/common.cpp
  src/signing.cpp
  src/ssrf.cpp
  src/http_client.cpp
  src/resources.cpp
  src/relay.cpp
  src/proxy.cpp
  src/client.cpp
)
target_include_directories(dominusnode PUBLIC include)
target_link_libraries(dominusnode PUBLIC CURL::libcurl nlohmann_json::nlohmann_json OpenSSL::Crypto Threads::Threads)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(dominusnode PRIVATE -Wall -Wextra)
endif()

enable_testing()
add_executable(dominusnode_tests
  tests/test_main.cpp
  tests/test_core.cpp
  tests/test_resources.cpp
  tests/test_signed.cpp
  tests/test_proxy.cpp
  tests/test_proxy_tls.cpp
)
target_link_libraries(dominusnode_tests PRIVATE dominusnode OpenSSL::SSL)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(dominusnode_tests PRIVATE -Wall -Wextra)
endif()
add_test(NAME dominusnode_tests COMMAND dominusnode_tests)
