//! 2.1 additions: masked exit class, node class fields, cursor paging.
mod common;

use common::*;
use dominusnode::proxy::build_proxy_username;
use dominusnode::types::NodeInfo;
use dominusnode::*;
use futures_util::StreamExt;
use serde_json::json;

#[test]
fn class_masked_username() {
    let o = ProxyRoutingOptions { ip_class: Some(IpClass::Masked), ..Default::default() };
    assert_eq!(build_proxy_username(&o).unwrap(), "class-masked");
}

#[tokio::test]
async fn nodes_iter_follows_next_cursor() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"nodes": [{"id": "a", "verifiedClass": "masked", "tierWeight": 0.25}], "nextCursor": "abc="})));
    m.push(r(200, json!({"nodes": [{"id": "b"}], "nextCursor": null})));
    let items: Vec<_> = c.nodes.iter(Some(1)).unwrap().collect().await;
    let nodes: Vec<NodeInfo> = items.into_iter().map(|x| x.unwrap()).collect();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].tier_weight, Some(0.25));
    assert_eq!(nodes[0].verified_class.as_deref(), Some("masked"));
    assert!(m.last().url.contains("cursor=abc%3D"), "{}", m.last().url);
}

#[tokio::test]
async fn payouts_iter_offset_fallback_and_bad_cursor() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"payouts": [{"id": "1"}]})));
    let items: Vec<_> = c.payouts.iter(Some(5)).unwrap().collect().await;
    assert_eq!(items.len(), 1);
    assert!(c.payouts.list_after(None, "bad cursor").await.is_err());
}

#[tokio::test]
async fn tier_weights() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"tier": {}, "tierWeights": {"masked": 0.25}})));
    let t = c.nodes.tier().await.unwrap();
    assert_eq!(t.tier_weights.unwrap().get("masked"), Some(&0.25));
}
