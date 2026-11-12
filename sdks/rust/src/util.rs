//! Constants, the `Secret` wrapper, validation helpers, signed-message builders,
//! proof-of-work and the signer abstraction.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::errors::{DominusNodeError, Result};

/// SDK version.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
/// `User-Agent` header value.
pub const USER_AGENT: &str = concat!("dominusnode-sdk-rust/", env!("CARGO_PKG_VERSION"));
/// Default API base URL.
pub const DEFAULT_BASE_URL: &str = "https://api.dominusnode.com";
/// Default proxy gateway host.
pub const DEFAULT_PROXY_HOST: &str = "proxy.dominusnode.com";
/// Default HTTP proxy port.
pub const DEFAULT_HTTP_PROXY_PORT: u32 = 8080;
/// Default SOCKS5 proxy port.
pub const DEFAULT_SOCKS5_PROXY_PORT: u32 = 1080;
/// Refresh JWTs this many seconds before expiry.
pub const TOKEN_REFRESH_BUFFER_SECS: u64 = 60;
/// Hard cap on any response body (API or proxy fetch).
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
/// API request timeout (ms).
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// 429 retry wait cap (ms).
pub const MAX_RETRY_WAIT_MS: u64 = 10_000;
/// 429 retry wait floor (ms).
pub const MIN_RETRY_WAIT_MS: u64 = 100;
/// Largest `*_cents` argument (PostgreSQL INTEGER max).
pub const MAX_AMOUNT_CENTS: i64 = 2_147_483_647;

pub(crate) const REDACTED: &str = "[REDACTED]";

// ---------------------------------------------------------------- Secret

/// A credential returned once by the server (API key, team key, node key).
/// `Debug`, `Display` and `Serialize` print `[REDACTED]`; the value is zeroized on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Wrap a value.
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }
    /// The raw value.
    pub fn reveal(&self) -> &str {
        &self.0
    }
    /// First 8 characters (safe for logs).
    pub fn prefix(&self) -> String {
        self.0.chars().take(8).collect()
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}
impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}
impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(REDACTED)
    }
}
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Ok(Secret::new(String::deserialize(d)?))
    }
}

// ---------------------------------------------------------------- validation

fn all_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && all_hex(&s[2..])
}
pub(crate) fn validate_address(s: &str, name: &str) -> Result<()> {
    if is_address(s) {
        Ok(())
    } else {
        Err(DominusNodeError::invalid_arg(format!(
            "{name} must be an Ethereum address (0x followed by 40 hex characters)"
        )))
    }
}
pub(crate) fn validate_signature(s: &str, name: &str) -> Result<()> {
    if s.len() > 200 {
        return Err(DominusNodeError::invalid_arg(format!("{name} must not exceed 200 characters")));
    }
    if !(s.len() == 132 && s.starts_with("0x") && all_hex(&s[2..])) {
        return Err(DominusNodeError::invalid_arg(format!(
            "{name} must be an EIP-191 signature (0x followed by 130 hex characters)"
        )));
    }
    Ok(())
}
pub(crate) fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}
pub(crate) fn validate_uuid(s: &str, name: &str) -> Result<()> {
    if is_uuid(s) {
        Ok(())
    } else {
        Err(DominusNodeError::invalid_arg(format!("{name} must be a UUID")))
    }
}
pub(crate) fn is_hex64_lower(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn validate_idempotency_key(s: &str) -> Result<()> {
    let ok = (8..=120).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(DominusNodeError::invalid_arg("idempotencyKey must be 8-120 characters of [A-Za-z0-9_-]"))
    }
}
/// `^dn_(live|test)_[A-Za-z0-9_-]{8,200}$`
pub(crate) fn validate_api_key(s: &str) -> Result<()> {
    let rest = s.strip_prefix("dn_live_").or_else(|| s.strip_prefix("dn_test_"));
    match rest {
        Some(r) if (8..=200).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => Ok(()),
        _ => Err(DominusNodeError::invalid_arg("apiKey must be a dn_live_ or dn_test_ key")),
    }
}
pub(crate) fn validate_cents(v: i64, name: &str, allow_zero: bool) -> Result<i64> {
    let ok = (if allow_zero { v >= 0 } else { v > 0 }) && v <= MAX_AMOUNT_CENTS;
    if ok {
        Ok(v)
    } else {
        Err(DominusNodeError::invalid_arg(format!(
            "{name} must be an integer {} and <= {MAX_AMOUNT_CENTS}",
            if allow_zero { ">= 0" } else { "> 0" }
        )))
    }
}
pub(crate) fn validate_non_empty(v: &str, name: &str, max: usize) -> Result<()> {
    let n = v.chars().count();
    if n == 0 || n > max {
        Err(DominusNodeError::invalid_arg(format!("{name} must be a non-empty string (max {max})")))
    } else {
        Ok(())
    }
}
pub(crate) fn validate_int_range(v: i64, name: &str, min: i64, max: i64) -> Result<i64> {
    if v < min || v > max {
        Err(DominusNodeError::invalid_arg(format!("{name} must be an integer in [{min}, {max}]")))
    } else {
        Ok(v)
    }
}

/// µUSD amount input: an integer or a digit string `^[1-9][0-9]{0,15}$`.
/// Sent to the server as a decimal string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Musd {
    /// Integer amount (negative values are rejected).
    Int(i128),
    /// Decimal digit string.
    Str(String),
}
impl From<u64> for Musd {
    fn from(v: u64) -> Self {
        Musd::Int(v as i128)
    }
}
impl From<i64> for Musd {
    fn from(v: i64) -> Self {
        Musd::Int(v as i128)
    }
}
impl From<u128> for Musd {
    fn from(v: u128) -> Self {
        Musd::Int(i128::try_from(v).unwrap_or(i128::MAX))
    }
}
impl From<i32> for Musd {
    fn from(v: i32) -> Self {
        Musd::Int(v as i128)
    }
}
impl From<&str> for Musd {
    fn from(v: &str) -> Self {
        Musd::Str(v.to_string())
    }
}
impl From<String> for Musd {
    fn from(v: String) -> Self {
        Musd::Str(v)
    }
}

pub(crate) fn to_musd(v: Musd, min: i128, max: i128) -> Result<String> {
    let bad = || DominusNodeError::invalid_arg("amountMusd must be a positive integer number of µUSD (integer or digit string)");
    let n = match v {
        Musd::Int(n) => n,
        Musd::Str(s) => {
            let b = s.as_bytes();
            if b.is_empty() || b.len() > 16 || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
                return Err(bad());
            }
            s.parse::<i128>().map_err(|_| bad())?
        }
    };
    if n < min || n > max {
        return Err(DominusNodeError::invalid_arg(format!("amountMusd must be between {min} and {max} µUSD")));
    }
    Ok(n.to_string())
}

/// `encodeURIComponent` semantics.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `URLSearchParams` (application/x-www-form-urlencoded) value encoding.
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build `?k=v&...`, omitting unset values.
pub(crate) fn qs(params: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{}={}", form_encode(k), form_encode(v))))
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// New idempotency key: `dn-` + UUIDv4.
pub fn new_idempotency_key() -> String {
    format!("dn-{}", uuid::Uuid::new_v4())
}

// ---------------------------------------------------------------- messages

/// Node attestation message (`packages/shared/src/attestation.ts`).
pub fn build_attestation_message(
    wallet: &str,
    nonce: &str,
    attestation_version: i64,
    attestation_text: &str,
    node_pubkey: Option<&str>,
) -> String {
    [
        "DomiNode node attestation".to_string(),
        format!("Version: {attestation_version}"),
        format!("Wallet: {}", wallet.to_lowercase()),
        format!("Nonce: {nonce}"),
        format!("Node pubkey: {}", node_pubkey.unwrap_or("none")),
        String::new(),
        attestation_text.to_string(),
    ]
    .join("\n")
}

/// Payout-wallet message (`routes/v1/credits.ts payoutWalletMessage`).
pub fn build_payout_wallet_message(user_id: &str, wallet: &str, address: &str, chain: &str, nonce: &str) -> String {
    [
        "DominusNode payout wallet".to_string(),
        "Action: payout_wallet_set".to_string(),
        format!("User: {user_id}"),
        format!("Account wallet: {}", wallet.to_lowercase()),
        format!("Payout address: {}", address.to_lowercase()),
        format!("Chain: {chain}"),
        format!("Nonce: {nonce}"),
    ]
    .join("\n")
}

/// Withdrawal message (`routes/v1/credits.ts withdrawMessage`).
pub fn build_withdraw_message(user_id: &str, wallet: &str, amount_musd: &str, idempotency_key: &str, nonce: &str) -> String {
    [
        "DominusNode withdrawal".to_string(),
        "Action: withdraw".to_string(),
        format!("User: {user_id}"),
        format!("Account wallet: {}", wallet.to_lowercase()),
        format!("Amount (µUSD): {amount_musd}"),
        format!("Idempotency key: {idempotency_key}"),
        format!("Nonce: {nonce}"),
    ]
    .join("\n")
}

/// Take the user id from line 3 (`User: <uuid>`) of a server message.
pub fn extract_user_id(message: &str) -> Result<String> {
    let line = message.split('\n').nth(2).unwrap_or("");
    match line.strip_prefix("User: ") {
        Some(v) if is_uuid(v) => Ok(v.to_string()),
        _ => Err(DominusNodeError::protocol("challenge message has no valid User line")),
    }
}

pub(crate) fn assert_same_message(server: &str, local: &str, what: &str) -> Result<()> {
    if server != local {
        return Err(DominusNodeError::protocol(format!(
            "{what}: the server's message differs from the one built locally; refusing to sign \
             (wrong signer for the linked wallet, mismatched parameters, or protocol change)"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------- PoW

fn leading_zero_bits(d: &[u8]) -> u32 {
    let mut bits = 0;
    for &b in d {
        if b == 0 {
            bits += 8;
        } else {
            return bits + b.leading_zeros();
        }
    }
    bits
}

/// Smallest decimal `n >= 0` such that `sha256(prefix + n)` has `>= difficulty` leading zero bits.
pub fn solve_pow(prefix: &str, difficulty: f64, max_iterations: u64) -> Result<String> {
    if prefix.is_empty() || prefix.chars().count() > 256 {
        return Err(DominusNodeError::protocol("invalid PoW prefix"));
    }
    if difficulty.fract() != 0.0 || !(1.0..=32.0).contains(&difficulty) {
        return Err(DominusNodeError::protocol("invalid PoW difficulty"));
    }
    let d = difficulty as u32;
    let mut base = Sha256::new();
    base.update(prefix.as_bytes());
    for n in 0..max_iterations {
        let s = n.to_string();
        let mut h = base.clone();
        h.update(s.as_bytes());
        if leading_zero_bits(&h.finalize()) >= d {
            return Ok(s);
        }
    }
    Err(DominusNodeError::protocol("PoW not solved within iteration cap"))
}

/// Whether `sha256(prefix + n)` meets `difficulty` (for verification).
pub fn verify_pow(prefix: &str, n: &str, difficulty: u32) -> bool {
    let mut h = Sha256::new();
    h.update(prefix.as_bytes());
    h.update(n.as_bytes());
    leading_zero_bits(&h.finalize()) >= difficulty
}

// ---------------------------------------------------------------- signer

/// Boxed future returned by [`Signer::sign_message`].
pub type SignFuture<'a> = Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send + 'a>>;

/// Caller-supplied EIP-191 signer. `sign_message` MUST perform `personal_sign`
/// over the exact UTF-8 string and return a 0x + 130 hex signature. The SDK has
/// no crypto dependency: wrap alloy/ethers-rs/a HSM.
pub trait Signer: Send + Sync {
    /// 0x-prefixed 20-byte address.
    fn address(&self) -> &str;
    /// Sign `message`; an `Err` becomes a ProtocolError.
    fn sign_message<'a>(&'a self, message: &'a str) -> SignFuture<'a>;
}

/// Signer from a synchronous closure.
pub struct FnSigner<F> {
    address: String,
    f: F,
}
impl<F> FnSigner<F>
where
    F: Fn(&str) -> std::result::Result<String, String> + Send + Sync,
{
    /// `FnSigner::new("0x…", |msg| Ok(sign(msg)))`
    pub fn new(address: impl Into<String>, f: F) -> Self {
        Self { address: address.into(), f }
    }
}
impl<F> Signer for FnSigner<F>
where
    F: Fn(&str) -> std::result::Result<String, String> + Send + Sync,
{
    fn address(&self) -> &str {
        &self.address
    }
    fn sign_message<'a>(&'a self, message: &'a str) -> SignFuture<'a> {
        let r = (self.f)(message);
        Box::pin(async move { r })
    }
}
impl<F> fmt::Debug for FnSigner<F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FnSigner({})", self.address)
    }
}

pub(crate) fn assert_signer(s: &dyn Signer, name: &str) -> Result<()> {
    validate_address(s.address(), &format!("{name}.address"))
}

pub(crate) async fn sign(s: &dyn Signer, message: &str, name: &str) -> Result<String> {
    let sig = s
        .sign_message(message)
        .await
        .map_err(|e| DominusNodeError::protocol(format!("{name}.signMessage failed: {e}")))?;
    validate_signature(&sig, &format!("{name} signature")).map_err(|e| DominusNodeError::protocol(e.message()))?;
    Ok(sig)
}

/// Deserialize a byte count from a JSON number, a numeric string or null (0).
pub(crate) fn de_byte_count<'de, D>(d: D) -> std::result::Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::Null => Ok(0),
        serde_json::Value::Number(n) => n.as_i64().ok_or_else(|| D::Error::custom("byte count is not an integer")),
        serde_json::Value::String(s) => {
            let t = s.trim();
            let digits = t.strip_prefix('-').unwrap_or(t);
            if digits.is_empty() || digits.len() > 19 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(D::Error::custom("byte count is not a numeric string"));
            }
            t.parse::<i64>().map_err(|_| D::Error::custom("byte count out of range"))
        }
        _ => Err(D::Error::custom("byte count must be a number or numeric string")),
    }
}
