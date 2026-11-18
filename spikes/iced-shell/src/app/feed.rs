//! Turns a channel filled by background threads into a subscription.

use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use iced::futures::Stream;
use iced::futures::stream;
use tokio::sync::mpsc::UnboundedReceiver;

/// The receiving end of a channel, handed to the subscription once. The
/// name keeps the subscription alive across updates.
pub struct Feed<T> {
    name: &'static str,
    receiver: Arc<Mutex<Option<UnboundedReceiver<T>>>>,
}

impl<T> Feed<T> {
    pub fn new(name: &'static str, receiver: UnboundedReceiver<T>) -> Self {
        Self { name, receiver: Arc::new(Mutex::new(Some(receiver))) }
    }
}

impl<T> Clone for Feed<T> {
    fn clone(&self) -> Self {
        Self { name: self.name, receiver: Arc::clone(&self.receiver) }
    }
}

impl<T> Hash for Feed<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.name.hash(state);
    }
}

pub fn stream<T: Send + 'static>(feed: &Feed<T>) -> impl Stream<Item = T> + use<T> {
    let receiver = feed.receiver.lock().ok().and_then(|mut slot| slot.take());
    stream::unfold(receiver, |receiver| async move {
        let mut receiver = receiver?;
        let item = receiver.recv().await?;
        Some((item, Some(receiver)))
    })
}
