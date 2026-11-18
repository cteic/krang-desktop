//! Keeping a transcript at its newest line.
//!
//! A transcript is a scrollable anchored to its bottom. iced measures the
//! offset of such a scrollable from the bottom, so offset zero shows the
//! newest line and `snap_to_end` shows the oldest. The operations here name
//! the newest end by what it holds, and one of them reads where a scrollable
//! is, which the self-test and the unit test use.

use iced::advanced::widget::operation::{Outcome, Scrollable as ScrollState};
use iced::advanced::widget::{Id, Operation, operation};
use iced::widget::scrollable::{RelativeOffset, Scrollable};
use iced::{Element, Length, Rectangle, Theme, Vector};

use crate::style;

/// A scrollable that keeps its newest content in view as it grows.
pub fn anchored<'a, Message: 'a, Renderer>(
    content: impl Into<Element<'a, Message, Theme, Renderer>>,
    id: Id,
) -> Scrollable<'a, Message, Theme, Renderer>
where
    Renderer: iced::advanced::text::Renderer + 'a,
{
    Scrollable::new(content)
        .id(id)
        .direction(style::scroll_direction())
        .style(style::scrollbar)
        .anchor_bottom()
        .height(Length::Fill)
        .width(Length::Fill)
}

/// Brings an anchored scrollable back to its newest content.
pub fn to_newest<T>(id: Id) -> impl Operation<T> {
    operation::scrollable::snap_to(id, RelativeOffset::START.into())
}

/// Where a scrollable is, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Place {
    /// Content out of sight below the view. Zero at the newest line.
    pub below: f32,
    /// Content that does not fit in the view at all.
    pub hidden: f32,
}

/// Reads the [`Place`] of an anchored scrollable.
pub struct Locate {
    target: Id,
    place: Option<Place>,
}

impl Locate {
    pub fn new(target: Id) -> Self {
        Self {
            target,
            place: None,
        }
    }
}

impl Operation<Place> for Locate {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<Place>)) {
        operate(self);
    }

    fn scrollable(
        &mut self,
        id: Option<&Id>,
        bounds: Rectangle,
        content_bounds: Rectangle,
        translation: Vector,
        _state: &mut dyn ScrollState,
    ) {
        if Some(&self.target) == id {
            let hidden = (content_bounds.height - bounds.height).max(0.0);
            self.place = Some(Place {
                below: hidden - translation.y,
                hidden,
            });
        }
    }

    fn finish(&self) -> Outcome<Place> {
        self.place.map_or(Outcome::None, Outcome::Some)
    }
}

#[cfg(test)]
mod tests {
    use iced::Size;
    use iced::advanced::Widget;
    use iced::advanced::layout::{Layout, Limits};
    use iced::advanced::widget::Tree;
    use iced::widget::Space;

    use super::*;

    const VIEW: f32 = 500.0;
    const CONTENT: f32 = 2000.0;

    struct Transcript {
        widget: Scrollable<'static, (), Theme, ()>,
        tree: Tree,
        id: Id,
    }

    impl Transcript {
        fn new() -> Self {
            let id = Id::new("transcript");
            let widget = anchored(Space::new().width(Length::Fill).height(CONTENT), id.clone());
            let tree = Tree::new(&widget as &dyn Widget<(), Theme, ()>);
            Self { widget, tree, id }
        }

        fn run<T>(&mut self, operation: &mut dyn Operation<T>) {
            let limits = Limits::new(Size::ZERO, Size::new(400.0, VIEW));
            let node = self.widget.layout(&mut self.tree, &(), &limits);
            self.widget.operate(
                &mut self.tree,
                Layout::new(&node),
                &(),
                &mut operation::black_box(operation),
            );
        }

        fn place(&mut self) -> Option<Place> {
            let mut locate = Locate::new(self.id.clone());
            self.run(&mut locate);
            locate.place
        }
    }

    #[test]
    fn a_transcript_opens_at_its_newest_line() {
        let mut transcript = Transcript::new();
        assert_eq!(
            transcript.place(),
            Some(Place {
                below: 0.0,
                hidden: CONTENT - VIEW
            })
        );
    }

    #[test]
    fn to_newest_shows_the_newest_line_and_snap_to_end_does_not() {
        let mut transcript = Transcript::new();
        // What the chat pane did before: it showed the oldest line.
        let mut end =
            operation::scrollable::snap_to::<()>(transcript.id.clone(), RelativeOffset::END.into());
        transcript.run(&mut end);
        assert_eq!(
            transcript.place().map(|place| place.below),
            Some(CONTENT - VIEW)
        );

        let mut newest = to_newest::<()>(transcript.id.clone());
        transcript.run(&mut newest);
        assert_eq!(transcript.place().map(|place| place.below), Some(0.0));
    }
}
