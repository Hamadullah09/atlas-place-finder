// Desktop shell for SMA Place Finder.
//
// The application itself is unchanged: a local Node server that serves both the
// UI and the API. This wrapper starts that server as a child process, waits for
// it to answer, and shows it in a native window instead of a browser tab. The
// window is the only visible surface -- no console, no browser, no localhost URL
// for the user to know about.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// The server takes the first free port in this range, so the shell has to look
/// for it rather than assume one. Matches PORT_ATTEMPTS in the server.
const FIRST_PORT: u16 = 4000;
const PORT_ATTEMPTS: u16 = 10;

/// A cold start pulls a 57 MB binary off disk and opens the cache; a slow
/// machine can take a while, and giving up early would look like a crash.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// Keeps the server handle so it can be stopped when the window closes.
struct Server(Mutex<Option<Child>>);

impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// True when a Place Finder with a UI answers on this port.
///
/// The `ui` flag matters: a developer running the API-only server on 4000 would
/// otherwise be adopted, and the window would show a JSON 404.
fn responds(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/health");
    match ureq::get(&url).timeout(Duration::from_millis(1200)).call() {
        Ok(response) => match response.into_string() {
            Ok(body) => body.contains("\"status\":\"ok\"") && body.contains("\"ui\":true"),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

fn find_server() -> Option<u16> {
    (FIRST_PORT..FIRST_PORT + PORT_ATTEMPTS).find(|port| responds(*port))
}

/// Starts the bundled server, unless one is already running.
///
/// Reusing a live instance means opening the app twice shows the same session
/// rather than fighting over the port, which is how the console build behaves.
fn start_server(app: &tauri::App) -> Result<Option<Child>, String> {
    if find_server().is_some() {
        return Ok(None);
    }

    let exe = app
        .path()
        .resolve("SMA-Place-Finder.exe", tauri::path::BaseDirectory::Resource)
        .map_err(|error| format!("cannot locate the bundled server: {error}"))?;

    let working_dir = exe
        .parent()
        .ok_or_else(|| "bundled server has no parent directory".to_string())?;

    let child = Command::new(&exe)
        .current_dir(working_dir)
        // Without this the server opens a browser tab as well as this window.
        .env("PLACE_FINDER_NO_BROWSER", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start the server: {error}"))?;

    Ok(Some(child))
}

fn wait_for_server() -> Result<u16, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(port) = find_server() {
            return Ok(port);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "The Place Finder service did not start within {} seconds.",
                STARTUP_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = start_server(app)?;
            app.manage(Server(Mutex::new(child)));

            let port = wait_for_server()?;
            let url = format!("http://localhost:{port}");

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().map_err(|_| "invalid server URL")?),
            )
            .title("SMA Place Finder")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .resizable(true)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start SMA Place Finder");
}
