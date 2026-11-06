#pragma once
// Tiny one-shot-per-connection HTTP server on 127.0.0.1 for transport/proxy tests.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace t {

class FakeServer {
public:
    /// handler(raw request head) -> raw response bytes. Connection closed after writing.
    explicit FakeServer(std::function<std::string(const std::string&)> handler) : handler_(std::move(handler)) {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = 0;
        if (::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(fd_, 8) != 0) {
            throw std::runtime_error("FakeServer bind failed");
        }
        socklen_t len = sizeof a;
        getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &len);
        port_ = ntohs(a.sin_port);
        thread_ = std::thread([this] { loop(); });
    }
    ~FakeServer() {
        stop_ = true;
        ::shutdown(fd_, SHUT_RDWR);
        ::close(fd_);
        if (thread_.joinable()) thread_.join();
    }
    int port() const { return port_; }
    std::vector<std::string> requests() {
        std::lock_guard<std::mutex> l(mu_);
        return requests_;
    }

private:
    void loop() {
        while (!stop_) {
            int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) return;
            std::string head;
            char buf[4096];
            while (head.find("\r\n\r\n") == std::string::npos) {
                ssize_t n = ::recv(c, buf, sizeof buf, 0);
                if (n <= 0) break;
                head.append(buf, static_cast<size_t>(n));
            }
            {
                std::lock_guard<std::mutex> l(mu_);
                requests_.push_back(head);
            }
            std::string resp = handler_(head);
            size_t off = 0;
            while (off < resp.size()) {
                ssize_t n = ::send(c, resp.data() + off, resp.size() - off, MSG_NOSIGNAL);
                if (n <= 0) break;
                off += static_cast<size_t>(n);
            }
            ::shutdown(c, SHUT_WR);
            while (::recv(c, buf, sizeof buf, 0) > 0) {
            }
            ::close(c);
        }
    }

    std::function<std::string(const std::string&)> handler_;
    int fd_ = -1;
    int port_ = 0;
    std::atomic<bool> stop_{false};
    std::thread thread_;
    std::mutex mu_;
    std::vector<std::string> requests_;
};

}  // namespace t
