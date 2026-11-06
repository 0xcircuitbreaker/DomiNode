//! CONNECT tunnel integrity (no direct dial to the target) and gateway TLS.
mod common;
use std::process::Command;
use std::sync::{Arc, Mutex};

use common::*;
use dominusnode::{DominusNodeError, GatewayTls, ProxyFetchOptions, ProxyProtocol, ProxyRoutingOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

/// Self-signed cert for localhost / 127.0.0.1 (PEM cert, PEM PKCS#8 key) via the openssl CLI.
fn cert() -> (Vec<u8>, Vec<u8>) {
    let dir = std::env::temp_dir().join(format!("dn-rust-tls-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let (crt, key) = (dir.join("gw.crt"), dir.join("gw.key"));
    let st = Command::new("openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost"])
        .args(["-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&crt)
        .output()
        .expect("openssl");
    assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stderr));
    let out = (std::fs::read(&crt).unwrap(), std::fs::read(&key).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
    out
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

#[derive(Default)]
struct Seen {
    accepted: usize,
    heads: Vec<String>,
    tunneled: Vec<Vec<u8>>,
}

async fn read_head<S: AsyncRead + Unpin>(s: &mut S) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        match s.read(&mut b).await {
            Ok(1) => buf.push(b[0]),
            _ => break,
        }
    }
    buf
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, seen: Arc<Mutex<Seen>>, http_resp: &[u8]) {
    let head = read_head(&mut s).await;
    let text = String::from_utf8_lossy(&head).into_owned();
    seen.lock().unwrap().heads.push(text.clone());
    if text.starts_with("CONNECT ") {
        let _ = s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await;
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(std::time::Duration::from_secs(3), s.read(&mut buf)).await.ok().and_then(|r| r.ok()).unwrap_or(0);
        seen.lock().unwrap().tunneled.push(buf[..n].to_vec());
    } else {
        let _ = s.write_all(http_resp).await;
    }
    let _ = s.shutdown().await;
}

/// Fake gateway; with `tls` = (cert, key) it is an HTTPS proxy.
async fn gateway(tls: Option<(Vec<u8>, Vec<u8>)>, http_resp: &'static [u8]) -> (u16, Arc<Mutex<Seen>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let s2 = seen.clone();
    let acceptor = tls.map(|(c, k)| {
        let id = native_tls::Identity::from_pkcs8(&c, &k).unwrap();
        tokio_native_tls::TlsAcceptor::from(native_tls::TlsAcceptor::new(id).unwrap())
    });
    tokio::spawn(async move {
        while let Ok((sock, _)) = l.accept().await {
            s2.lock().unwrap().accepted += 1;
            let seen = s2.clone();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                match acceptor {
                    None => serve(sock, seen, http_resp).await,
                    Some(a) => {
                        if let Ok(t) = a.accept(sock).await {
                            serve(t, seen, http_resp).await
                        }
                    }
                }
            });
        }
    });
    (port, seen)
}

fn fetch_opts() -> ProxyFetchOptions {
    ProxyFetchOptions { api_key: Some(API_KEY.into()), timeout_ms: Some(5000), ..Default::default() }
}

fn assert_client_hello(data: &[u8], sni: &str) {
    assert_eq!(data.first(), Some(&0x16), "first tunneled bytes must be a TLS handshake record");
    assert!(data.windows(sni.len()).any(|w| w == sni.as_bytes()), "ClientHello must carry the target SNI");
}

#[tokio::test]
async fn https_rides_connect_tunnel_plain_gateway() {
    let (port, seen) = gateway(None, b"").await;
    let m = Mock::default();
    let c = client_with(&m, |cfg| {
        cfg.proxy_host = "127.0.0.1".into();
        cfg.http_proxy_port = port as u32;
    });
    let e = c.proxy.fetch("https://example.com/x", fetch_opts()).await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Proxy(_)));
    let s = seen.lock().unwrap();
    assert_eq!(s.accepted, 1);
    assert!(s.heads[0].starts_with("CONNECT example.com:443 HTTP/1.1\r\n"));
    assert_client_hello(&s.tunneled[0], "example.com");
}

#[tokio::test]
async fn gateway_tls_connect_inside_tls() {
    let (crt, key) = cert();
    let (port, seen) = gateway(Some((crt.clone(), key)), b"").await;
    let m = Mock::default();
    let c = client_with(&m, |cfg| {
        cfg.proxy_host = "localhost".into();
        cfg.gateway_tls = Some(GatewayTls { port: Some(port as u32), ca_pem: Some(crt), servername: None });
    });
    let o = ProxyFetchOptions { routing: ProxyRoutingOptions { country: Some("US".into()), ..Default::default() }, ..fetch_opts() };
    // The fake target cert is not publicly trusted, so the inner handshake fails after the tunnel.
    let e = c.proxy.fetch("https://example.com/x", o).await.unwrap_err();
    assert!(!e.message().contains(API_KEY));
    let s = seen.lock().unwrap();
    assert!(s.heads[0].starts_with("CONNECT example.com:443 HTTP/1.1\r\n"), "{}", s.heads[0]);
    use base64::Engine;
    let want = base64::engine::general_purpose::STANDARD.encode(format!("country-US:{API_KEY}"));
    assert!(s.heads[0].contains(&format!("Proxy-Authorization: Basic {want}")));
    assert_client_hello(&s.tunneled[0], "example.com");
}

#[tokio::test]
async fn gateway_tls_http_absolute_uri_with_ip_and_servername() {
    let (crt, key) = cert();
    let (port, seen) = gateway(Some((crt.clone(), key)), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi").await;
    let m = Mock::default();
    let c = client_with(&m, |cfg| {
        cfg.proxy_host = "127.0.0.1".into();
        cfg.gateway_tls = Some(GatewayTls { port: Some(port as u32), ca_pem: Some(crt), servername: Some("localhost".into()) });
    });
    let o = ProxyFetchOptions { routing: ProxyRoutingOptions { allow_http: true, ..Default::default() }, ..fetch_opts() };
    let r = c.proxy.fetch("http://example.com/p", o).await.unwrap();
    assert_eq!(r.text(), "hi");
    assert!(seen.lock().unwrap().heads[0].starts_with("GET http://example.com/p HTTP/1.1\r\n"));
}

#[tokio::test]
async fn gateway_tls_unverified_cert_refused_before_sending() {
    let (crt, key) = cert();
    let (port, seen) = gateway(Some((crt.clone(), key)), b"").await;
    for g in [
        GatewayTls { port: Some(port as u32), ca_pem: None, servername: None },
        GatewayTls { port: Some(port as u32), ca_pem: Some(crt.clone()), servername: Some("other.example".into()) },
    ] {
        let m = Mock::default();
        let c = client_with(&m, |cfg| {
            cfg.proxy_host = "localhost".into();
            cfg.gateway_tls = Some(g);
        });
        let e = c.proxy.fetch("https://example.com/", fetch_opts()).await.unwrap_err();
        assert!(matches!(e, DominusNodeError::Proxy(_)), "{e:?}");
        assert!(!e.message().contains(API_KEY));
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(seen.lock().unwrap().heads.is_empty());
}

#[tokio::test]
async fn build_url_defaults_to_https_with_gateway_tls() {
    let m = Mock::default();
    let c = client_with(&m, |cfg| {
        cfg.proxy_host = "proxy.example.com".into();
        cfg.gateway_tls = Some(GatewayTls::default());
    });
    let u = c.proxy.build_url(&ProxyRoutingOptions::default(), ProxyProtocol::default(), Some(API_KEY)).unwrap();
    assert!(u.starts_with("https://relay:dn_live_") && u.ends_with("@proxy.example.com:8443"), "{u}");
    let u = c.proxy.build_url(&ProxyRoutingOptions::default(), ProxyProtocol::Http, Some(API_KEY)).unwrap();
    assert!(u.ends_with(":8080"));
    let plain = client_with(&m, |cfg| cfg.proxy_host = "proxy.example.com".into());
    let u = plain.proxy.build_url(&ProxyRoutingOptions::default(), ProxyProtocol::Auto, Some(API_KEY)).unwrap();
    assert!(u.starts_with("http://") && u.ends_with(":8080"));
    assert!(plain.proxy.build_url(&ProxyRoutingOptions::default(), ProxyProtocol::Https, Some(API_KEY)).is_err());
}

#[test]
fn gateway_tls_config_validation() {
    for g in [
        GatewayTls { port: Some(0), ..Default::default() },
        GatewayTls { port: Some(70000), ..Default::default() },
        GatewayTls { servername: Some("bad name".into()), ..Default::default() },
        GatewayTls { ca_pem: Some(b"not pem".to_vec()), ..Default::default() },
    ] {
        let cfg = dominusnode::Config { gateway_tls: Some(g), ..Default::default() };
        assert!(matches!(dominusnode::DominusNodeClient::new(cfg), Err(DominusNodeError::Validation(_))));
    }
}
