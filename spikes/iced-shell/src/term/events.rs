//! The queue between a terminal's reader thread and the UI.
//!
//! The reader thread parses output while it holds the terminal lock, and
//! sends events from inside that lock. A send that can block would stall the
//! reader, and the UI thread then waits on the lock forever, which is the
//! deadlock `iced_term` 0.8 has under heavy output. So the channel is
//! unbounded, the send never blocks, and redraw requests are folded together:
//! while one is waiting for the UI, the reader sends no more, which keeps the
//! queue to a handful of events however fast the program prints.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use alacritty_terminal::event::{Event, EventListener};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// An event from one terminal, tagged with the terminal's id.
#[derive(Debug, Clone)]
pub struct TermEvent {
    pub id: u64,
    pub event: Event,
}

pub type Sender = UnboundedSender<TermEvent>;
pub type Receiver = UnboundedReceiver<TermEvent>;

/// One queue shared by every terminal in the window.
pub fn queue() -> (Sender, Receiver) {
    unbounded_channel()
}

#[derive(Clone)]
pub struct EventProxy {
    id: u64,
    sender: Sender,
    wakeup_pending: Arc<AtomicBool>,
}

impl EventProxy {
    pub fn new(id: u64, sender: Sender) -> Self {
        Self {
            id,
            sender,
            wakeup_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Called by the UI when it takes a redraw request, before it reads the
    /// grid. Output after this point asks for a new redraw.
    pub fn wakeup_taken(&self) {
        self.wakeup_pending.store(false, Ordering::Release);
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        if matches!(event, Event::Wakeup) && self.wakeup_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        // A closed queue means the window is gone; the event has nowhere to go.
        let _ = self.sender.send(TermEvent { id: self.id, event });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(receiver: &mut Receiver) -> Vec<String> {
        let mut seen = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            seen.push(format!("{}:{:?}", event.id, event.event));
        }
        seen
    }

    #[test]
    fn wakeups_fold_until_the_ui_takes_one() {
        let (sender, mut receiver) = queue();
        let proxy = EventProxy::new(7, sender);
        for _ in 0..10_000 {
            proxy.send_event(Event::Wakeup);
        }
        assert_eq!(drain(&mut receiver), ["7:Wakeup"]);

        proxy.wakeup_taken();
        proxy.send_event(Event::Wakeup);
        proxy.send_event(Event::Wakeup);
        assert_eq!(drain(&mut receiver), ["7:Wakeup"]);
    }

    #[test]
    fn other_events_are_never_folded() {
        let (sender, mut receiver) = queue();
        let proxy = EventProxy::new(1, sender);
        proxy.send_event(Event::Wakeup);
        proxy.send_event(Event::Title("a".into()));
        proxy.send_event(Event::Wakeup);
        proxy.send_event(Event::Title("b".into()));
        proxy.send_event(Event::Exit);
        assert_eq!(
            drain(&mut receiver),
            ["1:Wakeup", "1:Title(a)", "1:Title(b)", "1:Exit"]
        );
    }

    #[test]
    fn a_send_never_blocks_even_when_nobody_reads() {
        let (sender, receiver) = queue();
        let proxy = EventProxy::new(1, sender);
        for index in 0..100_000 {
            proxy.send_event(Event::Title(index.to_string()));
        }
        drop(receiver);
        // With the reader gone the send is dropped, not an error or a hang.
        proxy.send_event(Event::Exit);
    }

    #[test]
    fn terminals_sharing_the_queue_fold_on_their_own() {
        let (sender, mut receiver) = queue();
        let first = EventProxy::new(1, sender.clone());
        let second = EventProxy::new(2, sender);
        first.send_event(Event::Wakeup);
        second.send_event(Event::Wakeup);
        first.send_event(Event::Wakeup);
        assert_eq!(drain(&mut receiver), ["1:Wakeup", "2:Wakeup"]);
    }
}
