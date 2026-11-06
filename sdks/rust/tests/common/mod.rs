#![allow(dead_code)]
use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use dominusnode::ssrf::Resolver;
use dominusnode::transport::{BoxFuture, ResponseBody, Transport, TransportRequest, TransportResponse};
use dominusnode::{Config, DominusNodeClient, FnSigner};
use serde_json::{json, Value};

pub const API_KEY: &str = "dn_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const WALLET: &str = "0x1111111111111111111111111111111111111111";
pub const OTHER_WALLET: &str = "0x2222222222222222222222222222222222222222";
pub const USER_ID: &str = "11111111-2222-4333-8444-555555555555";
pub const UUID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub fn sig() -> String {
    format!("0x{}", "ab".repeat(65))
}
pub fn nonce() -> String {
    "f".repeat(64)
}

pub fn make_jwt(exp_offset: i64) -> String {
    let e = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    format!("{}.{}.c2ln", e(json!({"alg": "HS256"})), e(json!({"userId": "u", "exp": now + exp_offset})))
}

pub struct MockBody {
    pub data: Vec<u8>,
    pub read: Arc<AtomicBool>,
}
impl ResponseBody for MockBody {
    fn read_capped(self: Box<Self>, max: usize) -> BoxFuture<'static, Result<Option<Vec<u8>>, String>> {
        self.read.store(true, Ordering::SeqCst);
        let d = self.data;
        Box::pin(async move { Ok(if d.len() > max { None } else { Some(d) }) })
    }
}

#[derive(Clone, Debug)]
pub struct Call {
    pub method: String,
    pub url: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Value>,
}
impl Call {
    pub fn header(&self, n: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone())
    }
    pub fn auth(&self) -> Option<String> {
        self.header("authorization")
    }
}

pub enum Reply {
    Ok(u16, Vec<u8>, Vec<(String, String)>),
    Fail(String),
}

pub fn r(status: u16, body: Value) -> Reply {
    Reply::Ok(status, body.to_string().into_bytes(), vec![])
}
pub fn rh(status: u16, body: Value, headers: &[(&str, &str)]) -> Reply {
    Reply::Ok(status, body.to_string().into_bytes(), headers.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect())
}
pub fn raw(status: u16, body: &str) -> Reply {
    Reply::Ok(status, body.as_bytes().to_vec(), vec![])
}

#[derive(Clone, Default)]
pub struct Mock {
    pub replies: Arc<Mutex<VecDeque<Reply>>>,
    pub calls: Arc<Mutex<Vec<Call>>>,
    pub bodies_read: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}
impl Mock {
    pub fn push(&self, r: Reply) {
        self.replies.lock().unwrap().push_back(r);
    }
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    pub fn last(&self) -> Call {
        self.calls().last().cloned().expect("a call")
    }
    pub fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    pub fn clear(&self) {
        self.calls.lock().unwrap().clear();
        self.bodies_read.lock().unwrap().clear();
    }
}
impl Transport for Mock {
    fn send(&self, req: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, String>> {
        let path = req.url.strip_prefix("http://api.test").unwrap_or(&req.url).to_string();
        self.calls.lock().unwrap().push(Call {
            method: req.method.clone(),
            url: req.url.clone(),
            path,
            headers: req.headers.clone(),
            body: req.body.as_ref().map(|b| serde_json::from_slice(b).unwrap()),
        });
        let next = self.replies.lock().unwrap().pop_front();
        let flag = Arc::new(AtomicBool::new(false));
        self.bodies_read.lock().unwrap().push(flag.clone());
        Box::pin(async move {
            match next {
                None => Err(format!("unexpected request {}", req.url)),
                Some(Reply::Fail(m)) => Err(m),
                Some(Reply::Ok(status, data, mut headers)) => {
                    headers.push(("content-length".into(), data.len().to_string()));
                    Ok(TransportResponse { status, headers, body: Box::new(MockBody { data, read: flag }) })
                }
            }
        })
    }
}

pub fn public_resolver() -> Resolver {
    Arc::new(|_h: String| Box::pin(async { Ok(vec!["93.184.216.34".parse::<IpAddr>().unwrap()]) }))
}

pub fn client_with(mock: &Mock, cfg: impl FnOnce(&mut Config)) -> DominusNodeClient {
    let mut c = Config { base_url: "http://api.test".into(), transport: Some(Arc::new(mock.clone())), ..Default::default() };
    c.resolver = Some(public_resolver());
    cfg(&mut c);
    DominusNodeClient::new(c).unwrap()
}

pub fn client(mock: &Mock) -> DominusNodeClient {
    client_with(mock, |_| {})
}

/// Client connected with API_KEY (verify-key call consumed and cleared).
pub async fn connected() -> (DominusNodeClient, Mock) {
    let m = Mock::default();
    m.push(r(200, json!({"valid": true, "token": make_jwt(900), "refreshToken": make_jwt(86400), "userId": USER_ID, "email": "x@y"})));
    let c = client(&m);
    c.connect_with_key(API_KEY).await.unwrap();
    m.clear();
    (c, m)
}

/// Client holding only a JWT pair (no API key).
pub fn jwt_client(m: &Mock) -> DominusNodeClient {
    client_with(m, |c| {
        c.access_token = Some(make_jwt(900));
        c.refresh_token = Some(make_jwt(86400));
    })
}

pub type SignFn = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;
pub type TestSigner = FnSigner<SignFn>;

pub fn signer_for(address: &str, sig: String) -> (TestSigner, Arc<Mutex<Vec<String>>>) {
    let signed = Arc::new(Mutex::new(Vec::new()));
    let s2 = signed.clone();
    let f: SignFn = Box::new(move |m: &str| {
        s2.lock().unwrap().push(m.to_string());
        Ok(sig.clone())
    });
    (FnSigner::new(address, f), signed)
}
