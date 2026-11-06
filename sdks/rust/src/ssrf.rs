//! Client-side SSRF guard for `proxy.fetch`: target URL checks, private-address
//! table and a DNS-rebinding check over every resolved address.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::Arc;

use crate::errors::{DominusNodeError, Result};

/// Injectable resolver: hostname -> all A + AAAA addresses.
pub type Resolver =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = std::result::Result<Vec<IpAddr>, String>> + Send>> + Send + Sync>;

/// Default resolver (tokio `lookup_host`).
pub fn default_resolver() -> Resolver {
    Arc::new(|host: String| {
        Box::pin(async move {
            tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map(|it| it.map(|a| a.ip()).collect())
                .map_err(|e| e.to_string())
        })
    })
}

const BLOCKED_HOSTNAMES: [&str; 4] = ["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"];
const BLOCKED_SUFFIXES: [&str; 4] = [".localhost", ".local", ".internal", ".arpa"];

fn parse_part(p: &str) -> Option<u64> {
    let lower = p.to_ascii_lowercase();
    if let Some(h) = lower.strip_prefix("0x") {
        if h.is_empty() || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        return u64::from_str_radix(h, 16).ok();
    }
    if p.len() > 1 && p.starts_with('0') {
        if !p.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return None;
        }
        return u64::from_str_radix(p, 8).ok();
    }
    if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
        return p.parse().ok();
    }
    None
}

/// Decode decimal/hex/octal/short IPv4 forms (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`).
pub fn normalize_ipv4(host: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut nums = Vec::with_capacity(4);
    for p in &parts {
        nums.push(parse_part(p)?);
    }
    let last = nums.pop()?;
    if nums.iter().any(|n| *n > 255) {
        return None;
    }
    let rem = 4 - nums.len();
    if last >= 1u64 << (8 * rem as u32) {
        return None;
    }
    let mut bytes: Vec<u8> = nums.iter().map(|n| *n as u8).collect();
    for i in (0..rem).rev() {
        bytes.push(((last >> (8 * i)) & 0xff) as u8);
    }
    Some(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]))
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && (b == 18 || b == 19))
        || a >= 224
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    let b = ip.octets();
    let v4 = Ipv4Addr::new(b[12], b[13], b[14], b[15]);
    let zero10 = b[..10].iter().all(|x| *x == 0);
    if zero10 && b[10] == 0xff && b[11] == 0xff {
        return is_private_v4(v4);
    }
    if zero10 && b[10] == 0 && b[11] == 0 {
        return if b[12..15].iter().all(|x| *x == 0) { true } else { is_private_v4(v4) };
    }
    if b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b {
        return is_private_v4(v4);
    }
    (b[0] & 0xfe) == 0xfc
        || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
        || (b[0] == 0xfe && (b[1] & 0xc0) == 0xc0)
        || b[0] == 0xff
        || (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0 && b[3] == 0)
        || (b[0] == 0x20 && b[1] == 0x02)
        || (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8)
}

/// Whether `ip` is an address `proxy.fetch` must refuse.
pub fn is_private_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

/// Whether a host string is a private IP literal (any IPv4 spelling, bracketed/zoned IPv6).
pub fn is_private_ip(host: &str) -> bool {
    let mut ip = host.trim_start_matches('[').trim_end_matches(']');
    if let Some(i) = ip.find('%') {
        ip = &ip[..i];
    }
    if let Some(v4) = normalize_ipv4(ip) {
        return is_private_v4(v4);
    }
    match ip.parse::<Ipv6Addr>() {
        Ok(v6) => is_private_v6(v6),
        Err(_) => false,
    }
}

/// Parsed, validated fetch target.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub https: bool,
    /// Lowercased host, brackets kept for IPv6.
    pub host: String,
    pub url: reqwest::Url,
}

/// Validate a `proxy.fetch` target URL.
pub(crate) fn validate_target_url(url: &str) -> Result<Target> {
    let u = reqwest::Url::parse(url).map_err(|_| DominusNodeError::proxy("Invalid URL", None))?;
    let https = match u.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err(DominusNodeError::proxy("Only http: and https: URLs are supported", None)),
    };
    if !u.username().is_empty() || u.password().is_some() {
        return Err(DominusNodeError::proxy("URLs with embedded credentials are not allowed", None));
    }
    // The URL parser drops default ports, so compare against the raw text too.
    let explicit_port = raw_port(url);
    if let Some(p) = explicit_port.as_deref() {
        if !p.is_empty() && p != "80" && p != "443" {
            return Err(DominusNodeError::proxy("Only ports 80 and 443 are reachable through the relay network", None));
        }
    }
    let host = u.host_str().unwrap_or("").to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    if host.is_empty() {
        return Err(DominusNodeError::proxy("URL has no host", None));
    }
    if BLOCKED_HOSTNAMES.contains(&host.as_str()) || BLOCKED_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return Err(DominusNodeError::proxy("Requests to local/internal hostnames are blocked", None));
    }
    if is_private_ip(&host) {
        return Err(DominusNodeError::proxy("Requests to private/internal IP addresses are blocked", None));
    }
    Ok(Target { https, host, url: u })
}

fn raw_port(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let auth = &rest[..end];
    let hostport = auth.rsplit_once('@').map(|x| x.1).unwrap_or(auth);
    if let Some(i) = hostport.rfind(']') {
        return hostport[i + 1..].strip_prefix(':').map(str::to_string);
    }
    hostport.rsplit_once(':').map(|x| x.1.to_string())
}

/// DNS-rebinding guard: resolve and reject if resolution fails, is empty, or ANY address is private.
pub async fn assert_public_resolution(hostname: &str, resolver: &Resolver) -> Result<()> {
    let host = hostname.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_addr(ip) {
            return Err(DominusNodeError::proxy("Requests to private/internal IP addresses are blocked", None));
        }
        return Ok(());
    }
    let addrs = resolver(host.to_string())
        .await
        .map_err(|_| DominusNodeError::proxy(format!("DNS resolution failed for {host}"), None))?;
    if addrs.is_empty() {
        return Err(DominusNodeError::proxy(format!("DNS resolution returned no addresses for {host}"), None));
    }
    if addrs.into_iter().any(is_private_addr) {
        return Err(DominusNodeError::proxy("Hostname resolves to a private/internal IP address (blocked)", None));
    }
    Ok(())
}
