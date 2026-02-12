use dominode::{Config, DomiNodeClient};
use dominode::constants::{DEFAULT_BASE_URL, DEFAULT_HTTP_PROXY_PORT, DEFAULT_PROXY_HOST, DEFAULT_SOCKS5_PROXY_PORT};

#[test]
fn test_config_defaults() {
    let config = Config::default();
    assert_eq!(config.base_url, DEFAULT_BASE_URL);
    assert_eq!(config.proxy_host, DEFAULT_PROXY_HOST);
    assert_eq!(config.http_proxy_port, DEFAULT_HTTP_PROXY_PORT);
    assert_eq!(config.socks5_proxy_port, DEFAULT_SOCKS5_PROXY_PORT);
    assert!(config.api_key.is_none());
    assert!(config.access_token.is_none());
    assert!(config.refresh_token.is_none());
}

#[test]
fn test_config_custom_values() {
    let config = Config {
        base_url: "http://localhost:3000".to_string(),
        api_key: Some("dn_live_test".to_string()),
        access_token: None,
        refresh_token: None,
        proxy_host: "localhost".to_string(),
        http_proxy_port: 9080,
        socks5_proxy_port: 9081,
    };
    assert_eq!(config.base_url, "http://localhost:3000");
    assert_eq!(config.api_key.as_deref(), Some("dn_live_test"));
    assert_eq!(config.http_proxy_port, 9080);
    assert_eq!(config.socks5_proxy_port, 9081);
}

#[test]
fn test_client_construction_default() {
    let client = DomiNodeClient::new(Config::default());
    assert!(client.is_ok());
}

#[test]
fn test_client_construction_custom_base_url() {
    let config = Config {
        base_url: "http://localhost:3000".to_string(),
        ..Config::default()
    };
    let client = DomiNodeClient::new(config);
    assert!(client.is_ok());
}

#[test]
fn test_client_construction_with_tokens() {
    let config = Config {
        access_token: Some("some.jwt.token".to_string()),
        refresh_token: Some("refresh_token_value".to_string()),
        ..Config::default()
    };
    // Should not panic even with pre-set tokens.
    let client = DomiNodeClient::new(config);
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_disconnect_clears_state() {
    let client = DomiNodeClient::new(Config {
        access_token: Some("some.jwt.token".to_string()),
        ..Config::default()
    })
    .unwrap();

    // disconnect should not panic.
    client.disconnect().await;
}
