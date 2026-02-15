use dominusnode::{Config, DominusNodeClient};
use dominusnode::types::ProxyUrlOptions;

fn make_client() -> DominusNodeClient {
    DominusNodeClient::new(Config::default()).unwrap()
}

fn make_client_custom(host: &str, http_port: u16, socks5_port: u16) -> DominusNodeClient {
    DominusNodeClient::new(Config {
        proxy_host: host.to_string(),
        http_proxy_port: http_port,
        socks5_proxy_port: socks5_port,
        ..Config::default()
    })
    .unwrap()
}

#[test]
fn test_build_url_default_http() {
    let client = make_client();
    let url = client.proxy.build_url("dn_live_abc123", None);
    assert_eq!(url, "http://user:dn_live_abc123@proxy.dominusnode.com:8080");
}

#[test]
fn test_build_url_explicit_http() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        protocol: Some("http".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_abc123", Some(&opts));
    assert_eq!(url, "http://user:dn_live_abc123@proxy.dominusnode.com:8080");
}

#[test]
fn test_build_url_socks5() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        protocol: Some("socks5".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_abc123", Some(&opts));
    assert_eq!(url, "socks5://user:dn_live_abc123@proxy.dominusnode.com:1080");
}

#[test]
fn test_build_url_with_country() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        country: Some("US".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(url, "http://user-country_US:dn_live_key@proxy.dominusnode.com:8080");
}

#[test]
fn test_build_url_socks5_with_country() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        protocol: Some("socks5".to_string()),
        country: Some("US".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(
        url,
        "socks5://user-country_US:dn_live_key@proxy.dominusnode.com:1080"
    );
}

#[test]
fn test_build_url_with_state_and_city() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        country: Some("US".to_string()),
        state: Some("CA".to_string()),
        city: Some("LosAngeles".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(
        url,
        "http://user-country_US-state_CA-city_LosAngeles:dn_live_key@proxy.dominusnode.com:8080"
    );
}

#[test]
fn test_build_url_with_asn() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        asn: Some(13335),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(
        url,
        "http://user-asn_13335:dn_live_key@proxy.dominusnode.com:8080"
    );
}

#[test]
fn test_build_url_with_session_id() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        session_id: Some("sticky123".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(
        url,
        "http://user-session_sticky123:dn_live_key@proxy.dominusnode.com:8080"
    );
}

#[test]
fn test_build_url_all_options() {
    let client = make_client();
    let opts = ProxyUrlOptions {
        protocol: Some("socks5".to_string()),
        country: Some("DE".to_string()),
        state: Some("BY".to_string()),
        city: Some("Munich".to_string()),
        asn: Some(3320),
        session_id: Some("sess42".to_string()),
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(
        url,
        "socks5://user-country_DE-state_BY-city_Munich-asn_3320-session_sess42:dn_live_key@proxy.dominusnode.com:1080"
    );
}

#[test]
fn test_build_url_custom_host_and_port() {
    let client = make_client_custom("localhost", 9080, 9081);
    let url = client.proxy.build_url("dn_live_key", None);
    assert_eq!(url, "http://user:dn_live_key@localhost:9080");

    let opts = ProxyUrlOptions {
        protocol: Some("socks5".to_string()),
        ..Default::default()
    };
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(url, "socks5://user:dn_live_key@localhost:9081");
}

#[test]
fn test_build_url_empty_options() {
    let client = make_client();
    let opts = ProxyUrlOptions::default();
    let url = client.proxy.build_url("dn_live_key", Some(&opts));
    assert_eq!(url, "http://user:dn_live_key@proxy.dominusnode.com:8080");
}
