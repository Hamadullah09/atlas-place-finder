// Desktop shell for SMA Place Finder.
//
// The application itself is unchanged: a local Node server that serves both the
// UI and the API. This wrapper starts that server as a child process, waits for
// it to answer, and shows it in a native window instead of a browser tab. The
// window is the only visible surface -- no console, no browser, no localhost URL
// for the user to know about.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Keeps Windows from giving the server its own console window.
///
/// The server is a console program, so launching it from a windowed app opens
/// a black box on top of the UI -- redirecting its output does not prevent it,
/// only this flag does.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The server takes the first free port in this range, so the shell has to look
/// for it rather than assume one. Matches PORT_ATTEMPTS in the server.
const FIRST_PORT: u16 = 4000;
const PORT_ATTEMPTS: u16 = 10;

/// A cold start pulls a 57 MB binary off disk and opens the cache; a slow
/// machine can take a while, and giving up early would look like a crash.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// How long to wait for a TCP connection to a local port before calling it
/// closed. Loopback answers in microseconds; this only has to outlast a busy
/// machine, not a network.
const PORT_CONNECT_TIMEOUT: Duration = Duration::from_millis(150);

/// Keeps the server handle so it can be stopped when the window closes.
struct Server(Mutex<Option<Child>>);

/// Ties the server's life to this process, however this process ends.
///
/// Stopping the server on a clean exit is not enough: a crash, a hang the user
/// ends from Task Manager, or an event loop that never finishes all skip that
/// code and would leave an invisible server holding the port -- which the next
/// launch then adopts. A job with KILL_ON_JOB_CLOSE is torn down by Windows
/// when the last handle to it closes, and the only handle belongs to this
/// process, so the server cannot outlive it.
fn bind_to_this_process(child: &Child) {
    // SAFETY: plain Win32 calls with a zeroed, correctly sized struct and a
    // handle owned by `child`, which outlives the call.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return; // Degrades to the explicit stop on window close.
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            return;
        }

        AssignProcessToJobObject(job, child.as_raw_handle() as _);
        // `job` is deliberately never closed. Windows closes it when this
        // process exits, and that is what ends the server.
    }
}

/// Whether anything accepts connections on this local port.
///
/// A plain TCP connect, not an HTTP request: a closed port is refused
/// instantly, where an HTTP client with a timeout made every closed port in
/// the range cost more than a second -- twenty seconds of blank screen before
/// the server was even started.
fn port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, PORT_CONNECT_TIMEOUT).is_ok()
}

/// True when a Place Finder with a UI answers on this port.
///
/// The `ui` flag matters: a developer running the API-only server on 4000 would
/// otherwise be adopted, and the window would show a JSON 404.
fn responds(port: u16) -> bool {
    if !port_open(port) {
        return false;
    }
    let url = format!("http://127.0.0.1:{port}/api/health");
    match ureq::get(&url).timeout(Duration::from_millis(1500)).call() {
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
        .resolve("place-finder-server.exe", tauri::path::BaseDirectory::Resource)
        .map_err(|error| format!("cannot locate the bundled server: {error}"))?;

    let working_dir = exe
        .parent()
        .ok_or_else(|| "bundled server has no parent directory".to_string())?;

    let child = Command::new(&exe)
        .creation_flags(CREATE_NO_WINDOW)
        .current_dir(working_dir)
        // Without this the server opens a browser tab as well as this window.
        .env("PLACE_FINDER_NO_BROWSER", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start the server: {error}"))?;

    bind_to_this_process(&child);
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
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Stops the server this shell started, if it started one.
fn stop_server(handle: &tauri::AppHandle) {
    if let Some(server) = handle.try_state::<Server>() {
        if let Ok(mut guard) = server.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
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
        .on_window_event(|window, event| {
            // The window is the whole application. Once it is gone, end the
            // process outright: waiting for the event loop to wind down on
            // its own left the shell running with no window, every time.
            if let tauri::WindowEvent::Destroyed = event {
                stop_server(window.app_handle());
                std::process::exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start SMA Place Finder")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                stop_server(handle);
            }
        });
}
