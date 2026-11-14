//! Requests that are waiting for a window's page to answer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Mutex;

use serde_json::Value;

#[derive(Default)]
pub struct Pending {
    waiting: Mutex<HashMap<String, SyncSender<Value>>>,
    counter: AtomicU64,
}

impl Pending {
    /// Makes a fresh request id and the channel its answer will arrive on.
    pub fn register(&self) -> Result<(String, Receiver<Value>), String> {
        let id = format!("r{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = mpsc::sync_channel(1);
        self.waiting
            .lock()
            .map_err(|_| String::from("the table of waiting requests is poisoned"))?
            .insert(id.clone(), sender);
        Ok((id, receiver))
    }

    /// Hands a page's answer to the connection waiting for it.
    pub fn complete(&self, id: &str, payload: Value) -> Result<(), String> {
        let sender = self
            .waiting
            .lock()
            .map_err(|_| String::from("the table of waiting requests is poisoned"))?
            .remove(id)
            .ok_or_else(|| format!("no request is waiting for {id}"))?;
        sender
            .send(payload)
            .map_err(|_| format!("request {id} stopped waiting"))
    }

    /// Drops a request nobody will answer, such as one that timed out.
    pub fn forget(&self, id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_answer_reaches_the_request_that_asked() {
        let pending = Pending::default();
        let (first, first_rx) = pending.register().unwrap();
        let (second, second_rx) = pending.register().unwrap();
        assert_ne!(first, second);

        pending.complete(&second, json!({"ok": true})).unwrap();
        assert_eq!(second_rx.try_recv().unwrap(), json!({"ok": true}));
        assert!(first_rx.try_recv().is_err());
    }

    #[test]
    fn an_answer_is_accepted_once() {
        let pending = Pending::default();
        let (id, _receiver) = pending.register().unwrap();
        pending.complete(&id, json!(1)).unwrap();
        assert_eq!(
            pending.complete(&id, json!(2)).unwrap_err(),
            format!("no request is waiting for {id}")
        );
    }

    #[test]
    fn a_forgotten_or_unknown_request_cannot_be_answered() {
        let pending = Pending::default();
        let (id, _receiver) = pending.register().unwrap();
        pending.forget(&id);
        assert!(pending.complete(&id, json!(1)).is_err());
        assert!(pending.complete("r999", json!(1)).is_err());
    }
}
