//! Proxy username/URL building, SSRF tables, URL refusals, DNS rebinding and a
//! local fake gateway for the fetch path.
mod common;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use common::*;
use dominusnode::ssrf::{is_private_ip, normalize_ipv4, Resolver};
use dominusnode::{DominusNodeError, FetchMethod, IpClass, ProxyFetchOptions, ProxyProtocol, ProxyRoutingOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn opts() -> ProxyRoutingOptions {
    ProxyRoutingOptions::default()
}

#[tokio::test]
async fn username_building() {
    let (c, _) = connected().await;
    assert_eq!(c.proxy.build_username(&opts()).unwrap(), "relay");
    let o = ProxyRoutingOptions {
        country: Some("us".into()),
        ip_class: Some(IpClass::Residential),
        session_id: Some("abc123".into()),
        agentic_wallet_id: Some(UUID.to_uppercase()),
        allow_http: true,
    };
    assert_eq!(c.proxy.build_username(&o).unwrap(), format!("country-US-class-residential-session-abc123-wallet-{UUID}-allowhttp-1"));
    assert_eq!(c.proxy.build_username(&ProxyRoutingOptions { ip_class: Some(IpClass::Dc), ..opts() }).unwrap(), "class-dc");
    assert_eq!(c.proxy.build_username(&ProxyRoutingOptions { ip_class: Some(IpClass::Mobile), ..opts() }).unwrap(), "class-mobile");
}

#[tokio::test]
async fn username_flag_validation_and_ofac() {
    let (c, _) = connected().await;
    for cc in ["CU", "ir", "KP", "ru", "SY"] {
        let e = c.proxy.build_username(&ProxyRoutingOptions { country: Some(cc.into()), ..opts() }).unwrap_err();
        assert_eq!(e.code(), Some("INVALID_ARGUMENT"));
        assert!(e.message().contains("OFAC"));
    }
    for bad in ["USA", "U", "1A", ""] {
        assert!(c.proxy.build_username(&ProxyRoutingOptions { country: Some(bad.into()), ..opts() }).is_err());
    }
    for bad in ["", "a-b", &"a".repeat(65)] {
        assert!(c.proxy.build_username(&ProxyRoutingOptions { session_id: Some(bad.into()), ..opts() }).is_err());
    }
    assert!(c.proxy.build_username(&ProxyRoutingOptions { agentic_wallet_id: Some("w".into()), ..opts() }).is_err());
}

#[tokio::test]
async fn url_building() {
    let (c, _) = connected().await;
    let o = ProxyRoutingOptions { country: Some("DE".into()), ..opts() };
    assert_eq!(c.proxy.build_url(&o, ProxyProtocol::Http, None).unwrap(), format!("http://country-DE:{API_KEY}@proxy.dominusnode.com:8080"));
    assert_eq!(c.proxy.build_url(&opts(), ProxyProtocol::Socks5, None).unwrap(), format!("socks5://relay:{API_KEY}@proxy.dominusnode.com:1080"));
    let other = "dn_test_bbbbbbbbbbbb";
    assert_eq!(c.proxy.build_url(&opts(), ProxyProtocol::Http, Some(other)).unwrap(), format!("http://relay:{other}@proxy.dominusnode.com:8080"));
    assert!(c.proxy.build_url(&opts(), ProxyProtocol::Http, Some("bad")).is_err());
    let m = Mock::default();
    let anon = client_with(&m, |cfg| {
        cfg.proxy_host = "gw.example".into();
        cfg.http_proxy_port = 9000;
    });
    assert!(matches!(anon.proxy.build_url(&opts(), ProxyProtocol::Http, None), Err(DominusNodeError::Authentication(_))));
    assert_eq!(anon.proxy.build_url(&opts(), ProxyProtocol::Http, Some(API_KEY)).unwrap(), format!("http://relay:{API_KEY}@gw.example:9000"));
}

#[test]
fn private_ipv4_table() {
    for ip in [
        "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
        "100.127.255.255", "192.0.0.1", "192.0.2.5", "192.0.1.1", "192.0.255.255", "198.18.0.1", "198.19.255.1", "224.0.0.1", "255.255.255.255",
        "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "017700000001",
    ] {
        assert!(is_private_ip(ip), "{ip}");
    }
    for ip in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.1.0.1", "198.20.0.1", "223.255.255.255", "93.184.216.34"] {
        assert!(!is_private_ip(ip), "{ip}");
    }
    assert_eq!(normalize_ipv4("127.1").unwrap().to_string(), "127.0.0.1");
    assert_eq!(normalize_ipv4("2130706433").unwrap().to_string(), "127.0.0.1");
    assert!(normalize_ipv4("256.1.1.1").is_none());
    assert!(normalize_ipv4("example.com").is_none());
}

#[test]
fn private_ipv6_table() {
    for ip in [
        "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "::7f00:1",
        "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fd12::1", "fe80::1%eth0", "[fe80::1%25eth0]", "fec0::1",
        "ff02::1", "2001:0000:4136:e378::1", "2001::1", "2002:7f00:1::", "2002::1", "2001:db8::1",
    ] {
        assert!(is_private_ip(ip), "{ip}");
    }
    for ip in ["2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2001:4860:4860::8888", "::8.8.8.8"] {
        assert!(!is_private_ip(ip), "{ip}");
    }
}

fn fopts() -> ProxyFetchOptions {
    ProxyFetchOptions::default()
}

#[tokio::test]
async fn url_refusals() {
    let (c, _) = connected().await;
    for u in [
        "ftp://example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "https://localhost/",
        "https://LOCALHOST./", "https://a.localhost/", "https://printer.local/", "https://svc.internal/", "https://1.in-addr.arpa/",
        "https://ip6-localhost/", "https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/",
        "https://[::ffff:7f00:1]/", "https://10.0.0.1/", "not a url",
    ] {
        let e = c.proxy.fetch(u, fopts()).await.unwrap_err();
        assert!(matches!(e, DominusNodeError::Proxy(_)), "{u}: {e:?}");
    }
    let e = c.proxy.fetch("http://example.com/", fopts()).await.unwrap_err();
    assert_eq!(e.code(), Some("INVALID_ARGUMENT"));
    let bad_hdr = ProxyFetchOptions { headers: vec![("X-A".into(), "v\r\nInjected: 1".into())], ..fopts() };
    assert_eq!(c.proxy.fetch("https://example.com/", bad_hdr).await.unwrap_err().code(), Some("INVALID_ARGUMENT"));
    let bad_name = ProxyFetchOptions { headers: vec![("Bad Name".into(), "v".into())], ..fopts() };
    assert_eq!(c.proxy.fetch("https://example.com/", bad_name).await.unwrap_err().code(), Some("INVALID_ARGUMENT"));
    let ofac = ProxyFetchOptions { routing: ProxyRoutingOptions { country: Some("IR".into()), ..opts() }, ..fopts() };
    assert_eq!(c.proxy.fetch("https://example.com/", ofac).await.unwrap_err().code(), Some("INVALID_ARGUMENT"));
}

fn resolver_of(ips: &'static [&'static str]) -> Resolver {
    Arc::new(move |_h: String| Box::pin(async move { Ok(ips.iter().map(|s| s.parse::<IpAddr>().unwrap()).collect()) }))
}

#[tokio::test]
async fn dns_rebinding_mixed_answer_refused() {
    let m = Mock::default();
    let c = client_with(&m, |cfg| cfg.resolver = Some(resolver_of(&["93.184.216.34", "10.0.0.5"])));
    let e = c.proxy.fetch("https://rebind.example/", ProxyFetchOptions { api_key: Some(API_KEY.into()), ..fopts() }).await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Proxy(_)));
    assert!(e.message().contains("private"));
    let c = client_with(&m, |cfg| cfg.resolver = Some(resolver_of(&[])));
    assert!(c.proxy.fetch("https://empty.example/", ProxyFetchOptions { api_key: Some(API_KEY.into()), ..fopts() }).await.is_err());
    let failing: Resolver = Arc::new(|_h| Box::pin(async { Err("nxdomain".to_string()) }));
    let c = client_with(&m, |cfg| cfg.resolver = Some(failing));
    let e = c.proxy.fetch("https://nx.example/", ProxyFetchOptions { api_key: Some(API_KEY.into()), ..fopts() }).await.unwrap_err();
    assert!(e.message().contains("DNS resolution failed"));
}

/// One-shot fake gateway: records the request head and writes `response`.
async fn gateway(response: Vec<u8>) -> (u16, Arc<Mutex<String>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(String::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        *s2.lock().unwrap() = String::from_utf8_lossy(&buf).into_owned();
        let _ = sock.write_all(&response).await;
        let _ = sock.shutdown().await;
    });
    (port, seen)
}

fn gw_client(port: u16) -> dominusnode::DominusNodeClient {
    let m = Mock::default();
    client_with(&m, |cfg| {
        cfg.proxy_host = "127.0.0.1".into();
        cfg.http_proxy_port = port as u32;
    })
}

fn basic(user: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{API_KEY}"))
}

#[tokio::test]
async fn http_fetch_via_gateway_absolute_uri_auth_and_redirect_not_followed() {
    let (port, seen) = gateway(b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi".to_vec()).await;
    let c = gw_client(port);
    let o = ProxyFetchOptions {
        routing: ProxyRoutingOptions { country: Some("US".into()), allow_http: true, ..opts() },
        headers: vec![("X-Test".into(), "1".into()), ("Authorization".into(), "drop-me".into())],
        api_key: Some(API_KEY.into()),
        ..fopts()
    };
    let res = c.proxy.fetch("http://example.com/path?q=1", o).await.unwrap();
    assert_eq!(res.status, 302);
    assert_eq!(res.headers.get("location").map(String::as_str), Some("http://169.254.169.254/"));
    assert_eq!(res.text(), "hi");
    assert!(!res.truncated);
    let req = seen.lock().unwrap().clone();
    assert!(req.starts_with("GET http://example.com/path?q=1 HTTP/1.1\r\n"), "{req}");
    let lower = req.to_lowercase();
    assert!(lower.contains(&format!("proxy-authorization: basic {}", basic("country-US-allowhttp-1")).to_lowercase()));
    assert!(lower.contains("host: example.com"));
    assert!(lower.contains("x-test: 1"));
    assert!(!lower.contains("drop-me"));
}

#[tokio::test]
async fn http_fetch_truncates_at_max_bytes() {
    let body = "x".repeat(5000);
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let (port, _) = gateway(resp.into_bytes()).await;
    let c = gw_client(port);
    let o = ProxyFetchOptions {
        routing: ProxyRoutingOptions { allow_http: true, ..opts() },
        max_bytes: Some(100),
        api_key: Some(API_KEY.into()),
        ..fopts()
    };
    let res = c.proxy.fetch("http://example.com/", o).await.unwrap();
    assert_eq!(res.body.len(), 100);
    assert!(res.truncated);
}

#[tokio::test]
async fn head_reads_no_body() {
    let (port, seen) = gateway(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n".to_vec()).await;
    let c = gw_client(port);
    let o = ProxyFetchOptions {
        routing: ProxyRoutingOptions { allow_http: true, ..opts() },
        method: FetchMethod::Head,
        api_key: Some(API_KEY.into()),
        ..fopts()
    };
    let res = c.proxy.fetch("http://example.com/", o).await.unwrap();
    assert!(res.body.is_empty());
    assert!(seen.lock().unwrap().starts_with("HEAD "));
}

#[tokio::test]
async fn connect_refusal_is_proxy_error() {
    let (port, seen) = gateway(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n".to_vec()).await;
    let c = gw_client(port);
    let e = c.proxy.fetch("https://example.com/x", ProxyFetchOptions { api_key: Some(API_KEY.into()), ..fopts() }).await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Proxy(_)), "{e:?}");
    assert_eq!(e.status_code(), Some(407));
    assert!(e.message().contains("HTTP 407"), "{}", e.message());
    assert!(!e.message().contains(API_KEY));
    let req = seen.lock().unwrap().clone();
    assert!(req.starts_with("CONNECT example.com:443 HTTP/1.1"), "{req}");
    assert!(req.to_lowercase().contains(&format!("proxy-authorization: basic {}", basic("relay")).to_lowercase()));
}
