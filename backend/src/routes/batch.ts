import { execFile } from 'node:child_process';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { parseBatchCsv } from '../lib/csv.js';
import {
  cancelBatchJob,
  getBatchJob,
  getRunningBatchJob,
  startBatchJob,
} from '../services/batch.js';

export const batchRouter = Router();

const csvSchema = z.string().min(1, 'CSV content is required').max(2 * 1024 * 1024);

const previewSchema = z.object({ csv: csvSchema });

const startSchema = z.object({
  csv: csvSchema,
  attribute: z.string().trim().min(2).max(80),
  outputPath: z.string().trim().min(3).max(500),
  /** Comma-separated or array — the UI sends whatever the user typed. */
  extraSources: z.union([z.string().max(4000), z.array(z.string().url()).max(20)]).optional(),
  includeImages: z.boolean().optional(),
  detailedWriteups: z.boolean().optional(),
  // Omit (or 0) to export every place found in each region.
  limit: z.number().int().min(0).max(config.maxResults).optional()
    .transform((value) => (value === 0 ? undefined : value)),
  overwrite: z.boolean().optional(),
  allowDuplicates: z.boolean().optional(),
  source: z.enum(['osm', 'google']).optional(),
});

function normalizeSources(value: string | string[] | undefined): { urls: string[]; bad: string[] } {
  const raw = Array.isArray(value)
    ? value
    : (value ?? '')
        .split(/[,\n]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

  const urls: string[] = [];
  const bad: string[] = [];
  for (const entry of raw) {
    try {
      const url = new URL(entry);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.toString());
      else bad.push(entry);
    } catch {
      bad.push(entry);
    }
  }
  return { urls: [...new Set(urls)].slice(0, 20), bad };
}

/**
 * Opens a native folder-picker on the machine the backend runs on. This app is
 * self-hosted — the server and the browser are the same computer — so a real
 * "Browse…" dialog is possible where a web page alone could never provide one.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
let pickerOpen = false;

/**
 * The dialog must NOT be spawned with `windowsHide` — CREATE_NO_WINDOW forces
 * SW_HIDE onto the process, and the folder dialog then opens invisibly (the
 * request just hangs until it times out). Instead the script hides its own
 * console via Win32 and raises the dialog with a transparent top-most owner,
 * so the user sees the dialog and nothing else.
 */
const PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -Name W -Namespace Native -MemberDefinition '
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'
$console = [Native.W]::GetConsoleWindow()
if ($console -ne [IntPtr]::Zero) { [Native.W]::ShowWindow($console, 0) | Out-Null }

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
[Native.W]::SetForegroundWindow($owner.Handle) | Out-Null

$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Choose where Place Finder saves the batch ZIP files'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
$owner.Dispose()
`;

/**
 * Start/poll rather than one long request: a user can sit on the dialog for
 * minutes, which is far longer than a browser fetch should be held open.
 */
type PickerOutcome =
  | { status: 'pending' }
  | { status: 'done'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

let pickerResult: PickerOutcome = { status: 'pending' };

batchRouter.post('/browse-folder', (req, res) => {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    res.status(403).json({ error: 'The folder picker only works when the app runs on this computer.' });
    return;
  }
  if (process.platform !== 'win32') {
    res.status(501).json({ error: 'The folder picker is only available on Windows. Type the path instead.' });
    return;
  }
  if (pickerOpen) {
    res.status(409).json({ error: 'A folder picker is already open — check your taskbar.' });
    return;
  }

  pickerOpen = true;
  pickerResult = { status: 'pending' };

  execFile(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PICKER_SCRIPT],
    { timeout: 10 * 60 * 1000, windowsHide: false },
    (error, stdout) => {
      pickerOpen = false;
      if (error) {
        pickerResult = {
          status: 'error',
          message: 'Could not open the folder picker — type or paste the path instead.',
        };
        return;
      }
      const picked = stdout.trim();
      // No output means the user pressed Cancel, which is not an error.
      pickerResult = picked ? { status: 'done', path: picked } : { status: 'cancelled' };
    },
  );

  res.status(202).json({ started: true });
});

batchRouter.get('/browse-folder', (_req, res) => {
  res.json(pickerOpen ? { status: 'pending' } : pickerResult);
});

/** Parse-only pass so the UI can show what a CSV contains before starting. */
batchRouter.post('/batch/preview', (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preview request.' });
    return;
  }
  res.json(parseBatchCsv(parsed.data.csv));
});

batchRouter.post('/batch', async (req, res, next) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid batch request.',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  const sheet = parseBatchCsv(parsed.data.csv);
  if (sheet.targets.length === 0) {
    res.status(400).json({ error: 'The CSV contains no usable city or province rows.', details: sheet.warnings });
    return;
  }

  const { urls, bad } = normalizeSources(parsed.data.extraSources);
  // Links embedded in the sheet itself count as sources too.
  const sheetSources = normalizeSources(sheet.sourceLinks).urls;
  const extraSources = [...new Set([...urls, ...sheetSources])].slice(0, 20);

  try {
    const job = await startBatchJob({
      targets: sheet.targets,
      attribute: parsed.data.attribute,
      outputPath: parsed.data.outputPath,
      extraSources,
      includeImages: parsed.data.includeImages,
      detailedWriteups: parsed.data.detailedWriteups,
      limit: parsed.data.limit,
      overwrite: parsed.data.overwrite,
      allowDuplicates: parsed.data.allowDuplicates,
      source:
        config.placeSource === 'both'
          ? (parsed.data.source ?? 'osm')
          : config.placeSource,
    });

    if (bad.length > 0) {
      job.notes.push(`Ignored ${bad.length} invalid source link(s): ${bad.join(', ')}`);
    }
    job.notes.push(...sheet.warnings);

    res.status(202).json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bad path or a job already running — the user's problem to fix, not a 500.
    if (/already running|absolute|not a directory|EACCES|EPERM|ENOENT/i.test(message)) {
      res.status(409).json({ error: message });
      return;
    }
    next(error);
  }
});

batchRouter.get('/batch/current', (_req, res) => {
  res.json({ job: getRunningBatchJob() });
});

batchRouter.get('/batch/:jobId', (req, res) => {
  const job = getBatchJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown batch job. It may have been evicted after a restart.' });
    return;
  }
  res.json({ job });
});

batchRouter.post('/batch/:jobId/cancel', (req, res) => {
  const ok = cancelBatchJob(req.params.jobId);
  if (!ok) {
    res.status(409).json({ error: 'That job is not running.' });
    return;
  }
  res.json({ ok: true });
});
