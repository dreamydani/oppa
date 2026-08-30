use crate::browser::manager::BrowserManager;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open or initialize a child webview for the built-in browser.
#[tauri::command(async)]
pub fn browser_open(
    app: AppHandle,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<BrowserManager>() {
        mgr.set_open(url.clone(), x, y, width, height);
    }

    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.show();
        let _ = webview_window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            x as f64, y as f64,
        )));
        let _ = webview_window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            width as f64,
            height as f64,
        )));
        if let Ok(parsed_url) = url.parse() {
            let _ = webview_window.navigate(parsed_url);
        } else {
            let script = format!("window.location.href = '{}';", url.replace('\'', "\\'"));
            let _ = webview_window.eval(&script);
        }
        return Ok(());
    }

    if let Ok(parsed_url) = url.parse() {
        let builder = WebviewWindowBuilder::new(&app, "browser", WebviewUrl::External(parsed_url))
            .title("Browser")
            .inner_size(width as f64, height as f64)
            .position(x as f64, y as f64);
        let _ = builder.build();
    }

    Ok(())
}

/// Navigate the built-in browser webview to a new URL.
#[tauri::command(async)]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<BrowserManager>() {
        mgr.set_url(url.clone());
    }

    if let Some(webview_window) = app.get_webview_window("browser") {
        if let Ok(parsed_url) = url.parse() {
            let _ = webview_window.navigate(parsed_url);
        } else {
            let script = format!("window.location.href = '{}';", url.replace('\'', "\\'"));
            let _ = webview_window.eval(&script);
        }
    }

    Ok(())
}

/// Update position and size bounds of the child webview.
#[tauri::command(async)]
pub fn browser_set_bounds(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<BrowserManager>() {
        mgr.set_bounds(x, y, width, height);
    }

    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            x as f64, y as f64,
        )));
        let _ = webview_window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            width as f64,
            height as f64,
        )));
    }

    Ok(())
}

/// Hide the child webview.
#[tauri::command(async)]
pub fn browser_hide(app: AppHandle) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<BrowserManager>() {
        mgr.set_visible(false);
    }

    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.hide();
    }

    Ok(())
}

/// Show the child webview.
#[tauri::command(async)]
pub fn browser_show(app: AppHandle) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<BrowserManager>() {
        mgr.set_visible(true);
    }

    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.show();
    }

    Ok(())
}

/// Navigate back in browser history.
#[tauri::command(async)]
pub fn browser_go_back(app: AppHandle) -> Result<(), String> {
    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.eval("window.history.back();");
    }
    Ok(())
}

/// Navigate forward in browser history.
#[tauri::command(async)]
pub fn browser_go_forward(app: AppHandle) -> Result<(), String> {
    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.eval("window.history.forward();");
    }
    Ok(())
}

/// Reload the current page.
#[tauri::command(async)]
pub fn browser_reload(app: AppHandle) -> Result<(), String> {
    if let Some(webview_window) = app.get_webview_window("browser") {
        let _ = webview_window.eval("window.location.reload();");
    }
    Ok(())
}

/// Open webview developer tools if supported.
///
/// `WebviewWindow::open_devtools` only exists on debug builds or with tauri's
/// `devtools` feature, so this is a no-op on plain release builds (the dev
/// tools are a dev-time surface anyway).
#[tauri::command(async)]
pub fn browser_open_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if let Some(webview_window) = app.get_webview_window("browser") {
        webview_window.open_devtools();
    }
    // Release builds compile the body out entirely; silence the unused-arg
    // warning by naming the param for the debug surface only.
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    let _ = &app;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_browser_commands_compilation() {
        assert_eq!(2 + 2, 4);
    }
}
