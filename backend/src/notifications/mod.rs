pub mod telegram;

pub fn send_notification(state: &std::sync::Arc<crate::app::AppState>, event: telegram::TelegramEvent) {
    let state = state.clone();
    tokio::spawn(async move {
        telegram::send_telegram_notification(state, event).await;
    });
}
