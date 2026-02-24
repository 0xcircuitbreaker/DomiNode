"""Tests for SSRF prevention utilities.

Validates that all private IP ranges, encoding tricks, DNS rebinding vectors,
and blocked hostnames are correctly identified and blocked.
"""

from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

import sys
import os

# Ensure shared package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shared.ssrf import check_dns_rebinding, is_private_ip, normalize_ipv4, validate_url


# ---------------------------------------------------------------------------
# normalize_ipv4 tests
# ---------------------------------------------------------------------------


class TestNormalizeIpv4:
    """Test non-standard IPv4 normalisation."""

    def test_decimal_integer_loopback(self):
        assert normalize_ipv4("2130706433") == "127.0.0.1"

    def test_hex_loopback(self):
        assert normalize_ipv4("0x7f000001") == "127.0.0.1"

    def test_octal_loopback(self):
        assert normalize_ipv4("0177.0.0.01") == "127.0.0.1"

    def test_normal_dotted_decimal(self):
        assert normalize_ipv4("192.168.1.1") == "192.168.1.1"

    def test_non_ip_hostname(self):
        assert normalize_ipv4("example.com") is None

    def test_mixed_hex_octal_octets(self):
        assert normalize_ipv4("0x7f.0.0.01") == "127.0.0.1"


# ---------------------------------------------------------------------------
# is_private_ip tests
# ---------------------------------------------------------------------------


class TestIsPrivateIp:
    """Test private/reserved IP detection across all forms."""

    def test_loopback_127(self):
        assert is_private_ip("127.0.0.1") is True

    def test_loopback_127_variant(self):
        assert is_private_ip("127.255.255.255") is True

    def test_private_10(self):
        assert is_private_ip("10.0.0.1") is True

    def test_private_172_16(self):
        assert is_private_ip("172.16.0.1") is True

    def test_private_172_31(self):
        assert is_private_ip("172.31.255.255") is True

    def test_private_192_168(self):
        assert is_private_ip("192.168.1.1") is True

    def test_cgnat_100_64(self):
        assert is_private_ip("100.64.0.1") is True

    def test_cgnat_100_127(self):
        assert is_private_ip("100.127.255.255") is True

    def test_link_local_169_254(self):
        assert is_private_ip("169.254.169.254") is True

    def test_multicast_224(self):
        assert is_private_ip("224.0.0.1") is True

    def test_reserved_240(self):
        assert is_private_ip("240.0.0.1") is True

    def test_zero_network(self):
        assert is_private_ip("0.0.0.0") is True

    def test_public_ip(self):
        assert is_private_ip("8.8.8.8") is False

    def test_public_ip_93(self):
        assert is_private_ip("93.184.216.34") is False

    # IPv6

    def test_ipv6_loopback(self):
        assert is_private_ip("::1") is True

    def test_ipv6_unspecified(self):
        assert is_private_ip("::") is True

    def test_ipv6_ula_fc(self):
        assert is_private_ip("fc00::1") is True

    def test_ipv6_ula_fd(self):
        assert is_private_ip("fd12:3456:789a::1") is True

    def test_ipv6_link_local(self):
        assert is_private_ip("fe80::1") is True

    def test_ipv6_multicast(self):
        assert is_private_ip("ff02::1") is True

    # IPv4-mapped IPv6

    def test_ipv4_mapped_ipv6_private(self):
        assert is_private_ip("::ffff:127.0.0.1") is True

    def test_ipv4_mapped_ipv6_public(self):
        assert is_private_ip("::ffff:8.8.8.8") is False

    def test_ipv4_mapped_ipv6_hex_private(self):
        # ::ffff:7f00:1 = ::ffff:127.0.0.1
        assert is_private_ip("::ffff:7f00:1") is True

    # IPv4-compatible IPv6

    def test_ipv4_compatible_ipv6_loopback(self):
        assert is_private_ip("::127.0.0.1") is True

    def test_ipv4_compatible_ipv6_private(self):
        assert is_private_ip("::10.0.0.1") is True

    # Teredo

    def test_teredo_private(self):
        # Teredo: 2001:0000:xxxx:xxxx:xxxx:xxxx:OBFUSCATED_IPV4
        # Last 32 bits XORed with 0xFFFFFFFF
        # To embed 127.0.0.1 (0x7f000001), XOR = 0x80FFFFFE
        assert is_private_ip("2001:0000:4136:e378:8000:63bf:80ff:fffe") is True

    # 6to4

    def test_6to4_private(self):
        # 2002:7f00:0001:: = 6to4 embedding 127.0.0.1
        assert is_private_ip("2002:7f00:0001::1") is True

    def test_6to4_public(self):
        # 2002:0808:0808:: = 6to4 embedding 8.8.8.8 -- all 6to4 blocked unconditionally
        assert is_private_ip("2002:0808:0808::1") is True

    # Zone ID stripping

    def test_zone_id_stripped(self):
        assert is_private_ip("fe80::1%eth0") is True

    def test_bracket_stripped(self):
        assert is_private_ip("[::1]") is True

    # Hex/octal normalisation

    def test_hex_encoded_loopback(self):
        assert is_private_ip("0x7f000001") is True

    def test_decimal_encoded_loopback(self):
        assert is_private_ip("2130706433") is True

    def test_octal_encoded_loopback(self):
        assert is_private_ip("0177.0.0.01") is True


# ---------------------------------------------------------------------------
# validate_url tests
# ---------------------------------------------------------------------------


class TestValidateUrl:
    """Test full URL validation including SSRF prevention."""

    def test_allows_https(self):
        result = validate_url("https://example.com/page")
        assert result == "https://example.com/page"

    def test_allows_http(self):
        result = validate_url("http://example.com/page")
        assert result == "http://example.com/page"

    def test_blocks_file_scheme(self):
        with pytest.raises(ValueError, match="Only http.*https"):
            validate_url("file:///etc/passwd")

    def test_blocks_ftp_scheme(self):
        with pytest.raises(ValueError, match="Only http.*https"):
            validate_url("ftp://example.com/file")

    def test_blocks_empty_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url("")

    def test_blocks_none_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url(None)  # type: ignore[arg-type]

    def test_blocks_long_url(self):
        with pytest.raises(ValueError, match="maximum length"):
            validate_url("https://example.com/" + "a" * 2100)

    def test_blocks_localhost(self):
        with pytest.raises(ValueError, match="localhost|loopback"):
            validate_url("http://localhost/secret")

    def test_blocks_loopback_ip(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://127.0.0.1/admin")

    def test_blocks_private_ip_10(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://10.0.0.1/internal")

    def test_blocks_private_ip_192_168(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://192.168.1.1/router")

    def test_blocks_dot_localhost(self):
        with pytest.raises(ValueError, match="localhost|loopback"):
            validate_url("http://evil.localhost/admin")

    def test_blocks_dot_local(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://printer.local/status")

    def test_blocks_dot_internal(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://service.internal/api")

    def test_blocks_dot_arpa(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://something.arpa/test")

    def test_blocks_embedded_credentials(self):
        with pytest.raises(ValueError, match="embedded credentials"):
            validate_url("http://user:pass@example.com/page")

    def test_blocks_embedded_username_only(self):
        with pytest.raises(ValueError, match="embedded credentials"):
            validate_url("http://admin@example.com/page")

    def test_blocks_missing_hostname(self):
        with pytest.raises(ValueError, match="hostname"):
            validate_url("http:///no-host")


# ---------------------------------------------------------------------------
# DNS rebinding tests
# ---------------------------------------------------------------------------


class TestCheckDnsRebinding:
    """Test DNS rebinding protection."""

    def test_skips_literal_ip(self):
        # Should not raise for a literal public IP (already validated by is_private_ip)
        check_dns_rebinding("8.8.8.8")

    def test_blocks_hostname_resolving_to_private(self):
        """Hostname that resolves to 127.0.0.1 should be blocked."""
        fake_info = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]
        with patch("shared.ssrf.socket.getaddrinfo", return_value=fake_info):
            with pytest.raises(ValueError, match="private IP"):
                check_dns_rebinding("evil-rebind.example.com")

    def test_allows_hostname_resolving_to_public(self):
        """Hostname that resolves to public IP should pass."""
        fake_info = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]
        with patch("shared.ssrf.socket.getaddrinfo", return_value=fake_info):
            check_dns_rebinding("example.com")

    def test_blocks_unresolvable_hostname(self):
        with patch(
            "shared.ssrf.socket.getaddrinfo",
            side_effect=socket.gaierror("Name resolution failed"),
        ):
            with pytest.raises(ValueError, match="Could not resolve"):
                check_dns_rebinding("nonexistent.invalid")

    def test_blocks_ipv6_private_resolution(self):
        """Hostname resolving to IPv6 loopback should be blocked."""
        fake_info = [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", ("::1", 0, 0, 0))]
        with patch("shared.ssrf.socket.getaddrinfo", return_value=fake_info):
            with pytest.raises(ValueError, match="private IP"):
                check_dns_rebinding("evil-ipv6.example.com")
