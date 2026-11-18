//! A widget that fills its space and reports its bounds when they change.
//! A web pane uses it to keep its native web view over the right spot.

use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer;
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Shell, mouse};
use iced::{Element, Event, Length, Rectangle, Size, Theme};

pub struct Probe<'a, Message> {
    on_bounds: Box<dyn Fn(Rectangle) -> Message + 'a>,
}

pub fn probe<'a, Message>(on_bounds: impl Fn(Rectangle) -> Message + 'a) -> Probe<'a, Message> {
    Probe {
        on_bounds: Box::new(on_bounds),
    }
}

#[derive(Default)]
struct Reported(Option<Rectangle>);

impl<Message> Widget<Message, Theme, iced::Renderer> for Probe<'_, Message> {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Reported>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Reported::default())
    }

    fn layout(
        &mut self,
        _tree: &mut Tree,
        _renderer: &iced::Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        layout::Node::new(limits.max())
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        _event: &Event,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _renderer: &iced::Renderer,
        _clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        let reported = tree.state.downcast_mut::<Reported>();
        let bounds = layout.bounds();
        if reported.0 != Some(bounds) {
            reported.0 = Some(bounds);
            shell.publish((self.on_bounds)(bounds));
            // A message published while iced redraws waits for the next
            // event; asking for another frame makes that event come now.
            shell.request_redraw();
        }
    }

    fn draw(
        &self,
        _tree: &Tree,
        _renderer: &mut iced::Renderer,
        _theme: &Theme,
        _style: &renderer::Style,
        _layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
    }
}

impl<'a, Message: 'a> From<Probe<'a, Message>> for Element<'a, Message, Theme, iced::Renderer> {
    fn from(probe: Probe<'a, Message>) -> Self {
        Element::new(probe)
    }
}
