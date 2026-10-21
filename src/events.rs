//! The narration the UI renders: every step of a payment, as it happens.
//!
//! Each wallet's timeline and the protocol lane between the two phones are
//! drawn from this one stream. A browser that connects late, or reloads in
//! the middle of a take, gets the history first and then the live events.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Actor {
    Alice,
    Bob,
    Directory,
    Chain,
    System,
}

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub seq: u64,
    pub at_ms: u64,
    pub actor: Actor,
    /// A stable identifier the UI keys its animations on, such as
    /// `alice.original_sent`.
    pub kind: &'static str,
    pub title: String,
    pub detail: Option<String>,
    pub data: Value,
}

pub struct Hub {
    tx: broadcast::Sender<Event>,
    history: Mutex<Vec<Event>>,
    seq: AtomicU64,
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            history: Mutex::new(Vec::new()),
            seq: AtomicU64::new(1),
        }
    }

    pub fn emit(
        &self,
        actor: Actor,
        kind: &'static str,
        title: impl Into<String>,
        detail: Option<String>,
        data: Value,
    ) {
        let event = Event {
            seq: self.seq.fetch_add(1, Ordering::SeqCst),
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or_default(),
            actor,
            kind,
            title: title.into(),
            detail,
            data,
        };
        tracing::info!("[{:?}] {} {}", event.actor, event.kind, event.title);
        self.history.lock().unwrap().push(event.clone());
        // Nobody listening is fine: the history keeps it.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> (Vec<Event>, broadcast::Receiver<Event>) {
        // Subscribe before copying the history so that no event falls between
        // the two. The UI drops duplicates by sequence number.
        let rx = self.tx.subscribe();
        let history = self.history.lock().unwrap().clone();
        (history, rx)
    }

    /// Forget the narration of earlier takes. The sequence keeps counting so
    /// that a connected browser can tell a reset from a replay.
    pub fn clear(&self) {
        self.history.lock().unwrap().clear();
    }
}
