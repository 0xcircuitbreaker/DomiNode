//! Pagination helpers: each returns a `Stream` of items that fetches pages on demand.
//! `limit` is the page size. An error ends the stream after it is yielded.

use std::collections::VecDeque;
use std::future::Future;

use futures_util::stream::{self, Stream};

use crate::errors::Result;
use crate::resources::{CreditsResource, NodesResource, PayoutsResource, UsageResource, WalletResource};
use crate::types::{CreditTransaction, NodeInfo, Payout, UsageRecord, WalletTransaction};
use crate::util::validate_int_range;

const MAX_OFFSET: i64 = 1_000_000;

struct OffsetState<T, F> {
    fetch: F,
    buf: VecDeque<T>,
    limit: i64,
    offset: i64,
    done: bool,
}

/// Offset pagination: `fetch(limit, offset)` returns the page items and the server total (if known).
fn offset_stream<T, F, Fut>(limit: i64, fetch: F) -> impl Stream<Item = Result<T>>
where
    F: FnMut(i64, i64) -> Fut,
    Fut: Future<Output = Result<(Vec<T>, Option<i64>)>>,
{
    let state = OffsetState { fetch, buf: VecDeque::new(), limit, offset: 0, done: false };
    stream::unfold(state, |mut st| async move {
        loop {
            if let Some(x) = st.buf.pop_front() {
                return Some((Ok(x), st));
            }
            if st.done {
                return None;
            }
            match (st.fetch)(st.limit, st.offset).await {
                Err(e) => {
                    st.done = true;
                    return Some((Err(e), st));
                }
                Ok((items, total)) => {
                    let n = items.len() as i64;
                    let reached_total = total.is_some_and(|t| st.offset + n >= t);
                    st.offset += st.limit;
                    st.done = n < st.limit || reached_total || st.offset > MAX_OFFSET;
                    st.buf.extend(items);
                }
            }
        }
    })
}

fn page_size(limit: Option<i64>, default: i64, max: i64) -> Result<i64> {
    let l = limit.unwrap_or(default);
    validate_int_range(l, "limit", 1, max)?;
    Ok(l)
}

fn valid_cursor(c: &str) -> bool {
    let b = c.as_bytes();
    !b.is_empty() && b.len() <= 19 && b[0] != b'0' && b.iter().all(u8::is_ascii_digit)
}

pub(crate) fn is_valid_cursor(c: &str) -> bool {
    valid_cursor(c)
}

struct CursorState {
    res: CreditsResource,
    limit: Option<i64>,
    tx_type: Option<String>,
    cursor: Option<String>,
    buf: VecDeque<CreditTransaction>,
    done: bool,
}

impl CreditsResource {
    /// Every credit transaction (newest first), following `nextCursor`. `limit` is the page size.
    pub fn iter_transactions(
        &self,
        limit: Option<i64>,
        tx_type: Option<&str>,
        start_cursor: Option<&str>,
    ) -> impl Stream<Item = Result<CreditTransaction>> {
        let state = CursorState {
            res: self.clone(),
            limit,
            tx_type: tx_type.map(str::to_owned),
            cursor: start_cursor.map(str::to_owned),
            buf: VecDeque::new(),
            done: false,
        };
        stream::unfold(state, |mut st| async move {
            loop {
                if let Some(x) = st.buf.pop_front() {
                    return Some((Ok(x), st));
                }
                if st.done {
                    return None;
                }
                match st.res.transactions(st.limit, st.cursor.as_deref(), st.tx_type.as_deref()).await {
                    Err(e) => {
                        st.done = true;
                        return Some((Err(e), st));
                    }
                    Ok(page) => {
                        let next = page.next_cursor.filter(|c| valid_cursor(c) && Some(c) != st.cursor.as_ref());
                        st.done = page.transactions.is_empty() || next.is_none();
                        st.cursor = next;
                        st.buf.extend(page.transactions);
                    }
                }
            }
        })
    }
}

impl PayoutsResource {
    /// Every payout (offset pagination; page size default 50, max 200).
    pub fn iter(&self, limit: Option<i64>) -> Result<impl Stream<Item = Result<Payout>>> {
        let limit = page_size(limit, 50, 200)?;
        let res = self.clone();
        Ok(offset_stream(limit, move |l, o| {
            let r = res.clone();
            async move { r.list(Some(l), Some(o)).await.map(|p| (p.payouts, None)) }
        }))
    }
}

impl NodesResource {
    /// Every node you own (offset pagination; page size default 100, max 500).
    pub fn iter(&self, limit: Option<i64>) -> Result<impl Stream<Item = Result<NodeInfo>>> {
        let limit = page_size(limit, 100, 500)?;
        let res = self.clone();
        Ok(offset_stream(limit, move |l, o| {
            let r = res.clone();
            async move { r.list(Some(l), Some(o)).await.map(|p| (p.nodes, None)) }
        }))
    }
}

impl UsageResource {
    /// Every usage record in the range (page size default 200, max 1000); stops at `pagination.total`.
    pub fn iter_records(&self, from: Option<&str>, to: Option<&str>, limit: Option<i64>) -> Result<impl Stream<Item = Result<UsageRecord>>> {
        let limit = page_size(limit, 200, 1000)?;
        let res = self.clone();
        let (from, to) = (from.map(str::to_owned), to.map(str::to_owned));
        Ok(offset_stream(limit, move |l, o| {
            let (r, from, to) = (res.clone(), from.clone(), to.clone());
            async move {
                let p = r.get(from.as_deref(), to.as_deref(), Some(l as u32), Some(o as u32)).await?;
                let total = (p.pagination.total > 0).then_some(p.pagination.total);
                Ok((p.records, total))
            }
        }))
    }
}

impl WalletResource {
    /// Every wallet transaction (page size default 50, server max 100).
    pub fn iter_transactions(&self, limit: Option<i64>) -> Result<impl Stream<Item = Result<WalletTransaction>>> {
        let limit = page_size(limit, 50, 100)?;
        let res = self.clone();
        Ok(offset_stream(limit, move |l, o| {
            let r = res.clone();
            async move { r.get_transactions(Some(l as u32), Some(o as u32)).await.map(|p| (p.transactions, None)) }
        }))
    }
}
