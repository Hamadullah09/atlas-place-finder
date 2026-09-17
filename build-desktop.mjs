/**
 * Builds the desktop app:
 *
 *   desktop/src-tauri/target/release/bundle/nsis/SMA Place Finder_1.0.0_x64-setup.exe
 *
 * The server is not rewritten for the desktop build -- the same packaged exe
 * that ships on its own is copied in as a resource, and the Rust shell starts
 * it and shows it in a window. One server, one behaviour, two front doors.
 *
 * Run from the place-finder folder:
 *   node build-desktop.mjs [--skip-server]
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const editionDir = path.join(root, 'dist-exe', 'SMA-Place-Finder');
const tauriDir = path.join(root, 'desktop', 'src-tauri');
const resources = path.join(tauriDir, 'resources');

const skipServer = process.argv.includes('--skip-server');

function run(command, cwd) {
  console.log(`\n> ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// 1. The packaged server, exactly as the standalone edition ships it.
// ---------------------------------------------------------------------------
if (!skipServer || !existsSync(path.join(editionDir, 'SMA-Place-Finder.exe'))) {
  run('node build-exe.mjs --edition=osm', root);
}

// ---------------------------------------------------------------------------
// 2. Stage it (plus sharp) where Tauri will pick it up as a resource.
// ---------------------------------------------------------------------------
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });

// Not "SMA-Place-Finder.exe": Tauri stages resources beside the compiled
// shell, whose binary is sma-place-finder.exe, and Windows would treat the
// two as one file and overwrite the shell.
cpSync(
  path.join(editionDir, 'SMA-Place-Finder.exe'),
  path.join(resources, 'place-finder-server.exe'),
);
// sharp is native, so it lives beside the server rather than inside it. The
// server looks for node_modules next to its own executable, which is where
// Tauri puts these resources.
cpSync(path.join(editionDir, 'node_modules'), path.join(resources, 'node_modules'), {
  recursive: true,
});

console.log('staged the server and sharp into desktop/src-tauri/resources');

// ---------------------------------------------------------------------------
// 3. The installer.
// ---------------------------------------------------------------------------
// The npm CLI ships a prebuilt binary; `cargo install tauri-cli` would
// compile it from source on every fresh machine for no benefit.
run('npx --no-install tauri build', path.join(root, 'desktop'));

console.log('\nDone. The installer is in');
console.log('  desktop\\src-tauri\\target\\release\\bundle\\nsis\\');
