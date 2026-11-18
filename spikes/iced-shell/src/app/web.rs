//! The web pane's toolbar and the space its web view covers.

use iced::widget::{button, column, container, row, text, text_input};
use iced::{Element, Length, Rectangle};

use crate::web::address;

use super::Message;
use super::probe::probe;

#[derive(Debug, Clone)]
pub enum WebMessage {
    Address(String),
    Go,
    Back,
    Forward,
    Reload,
    Bounds(Rectangle),
}

pub struct WebPane {
    pub url: String,
    pub address: String,
    pub title: Option<String>,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub error: Option<String>,
    /// Where the page goes in the window, as last reported by the layout.
    pub bounds: Option<Rectangle>,
}

impl WebPane {
    pub fn new(input: &str) -> Self {
        let url = address::resolve(input).unwrap_or_default();
        Self {
            address: address::display(&url),
            url,
            title: None,
            loading: false,
            can_back: false,
            can_forward: false,
            error: None,
            bounds: None,
        }
    }

    pub fn address_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("web-address-{id}"))
    }

    pub fn view(&self, id: u64) -> Element<'_, Message> {
        let message = move |message: WebMessage| Message::Web(id, message);
        let nav = |label: &'static str, enabled: bool, on: WebMessage| {
            button(text(label).size(13))
                .padding([2, 8])
                .style(button::text)
                .on_press_maybe(enabled.then(|| message(on)))
        };
        let toolbar = row![
            nav("‹", self.can_back, WebMessage::Back),
            nav("›", self.can_forward, WebMessage::Forward),
            nav(
                if self.loading { "×" } else { "⟳" },
                true,
                WebMessage::Reload
            ),
            text_input(
                "Address, localhost:3000 or a path to an HTML file",
                &self.address
            )
            .id(Self::address_id(id))
            .size(13)
            .padding([3, 6])
            .on_input(move |value| message(WebMessage::Address(value)))
            .on_submit(message(WebMessage::Go)),
            text(if self.loading { "Loading" } else { "" }).size(12),
        ]
        .spacing(4)
        .align_y(iced::Alignment::Center)
        .padding([4, 6]);
        let body: Element<'_, Message> = match &self.error {
            Some(error) => container(text(error.clone())).padding(12).into(),
            None => probe(move |bounds| message(WebMessage::Bounds(bounds))).into(),
        };
        column![
            toolbar,
            container(body).width(Length::Fill).height(Length::Fill)
        ]
        .into()
    }
}
