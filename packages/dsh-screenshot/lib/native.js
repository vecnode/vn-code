/**
 * dsh-screenshot — a real window, captured.
 *
 * The one thing a headless browser cannot photograph is an application: Notepad,
 * VS Code, Explorer, a game, a settings dialog. On Windows that is a real
 * capture with no permission dialog and no picker - `PrintWindow` with
 * `PW_RENDERFULLCONTENT` asks the window to draw itself into a memory bitmap,
 * which is what makes it possible to capture a window that is behind another one.
 *
 * The three honesties this file exists to keep:
 *
 *   - **It is Windows and it says so.** Everywhere else the answer is one
 *     sentence, not a silent empty picture. `dsh-wsl` is the precedent: a
 *     host-only surface that is inert and honest off its platform.
 *   - **The method is reported.** A GPU-composited window (Chrome with hardware
 *     acceleration, a video player) sometimes refuses `PrintWindow` and hands
 *     back a black rectangle: the pixel count catches that, and the fallback is a
 *     `BitBlt` of the screen at the window's own rectangle - which is ONLY valid
 *     while the window is unobscured. The answer names which one produced the
 *     pixels (`print` or `screen`), because they are not the same evidence.
 *   - **The scale comes from the window, not from a guess.** `GetDpiForWindow`
 *     is the window's own scale (1.5 on a 150% display), so the manifest can say
 *     "2248 px wide at 1.5x" and a README can ask for 1499 CSS pixels rather than
 *     publishing a picture twice the size it should be.
 *
 * The engine is the machine's own PowerShell (5.1 or 7) and the machine's own
 * GDI+. Nothing is installed, nothing is downloaded, and no dependency is added:
 * the C# below is compiled by `Add-Type` at the moment of the capture.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** The capture itself is bounded: a wedged window must not hold the session. */
export const NATIVE_TIMEOUT_MS = 30000

/** Whether this host can capture a native window at all. */
export function nativeAvailable(platform = process.platform) {
  return platform === 'win32'
}

/** The PowerShell to drive: an override, `pwsh`, or the one Windows always has. */
export function resolvePowerShell(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  const override = env.DSH_SCREENSHOT_POWERSHELL
  if (typeof override === 'string' && override !== '' && existsSync(override)) return { file: override, source: 'DSH_SCREENSHOT_POWERSHELL' }
  const dirs = String(env.PATH ?? '')
    .split(';')
    .filter((value) => value !== '')
  for (const name of ['pwsh.exe', 'pwsh']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return { file: candidate, source: 'PATH (PowerShell 7)' }
    }
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, 'powershell.exe')
    if (existsSync(candidate)) return { file: candidate, source: 'PATH (Windows PowerShell)' }
  }
  return { file: 'powershell.exe', source: 'System32' }
}

/**
 * The driver. It reads ONE json request and writes ONE json result, so no path,
 * title or crop rectangle is ever pasted into a command line: PowerShell's own
 * quoting rules are not something a caller should have to satisfy.
 */
export const NATIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = Get-Content -Raw -LiteralPath $env:DSH_SHOT_REQUEST | ConvertFrom-Json
$resultPath = $env:DSH_SHOT_RESULT

$code = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ShotNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

    const int SRCCOPY = 0x00CC0020;
    const int CAPTUREBLT = 0x40000000;
    const uint PW_RENDERFULLCONTENT = 0x2;

    static uint DpiOf(IntPtr h)
    {
        try { return GetDpiForWindow(h); } catch (Exception) { return 96; }
    }

    public static string[] List()
    {
        var rows = new List<string>();
        EnumWindows((h, l) =>
        {
            try
            {
                if (!IsWindowVisible(h)) return true;
                var title = new StringBuilder(512);
                if (GetWindowTextW(h, title, title.Capacity) <= 0) return true;
                var cls = new StringBuilder(256);
                GetClassNameW(h, cls, cls.Capacity);
                RECT r; GetWindowRect(h, out r);
                uint pid; GetWindowThreadProcessId(h, out pid);
                uint dpi = DpiOf(h);
                rows.Add(((long)h) + "|" + pid + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + IsIconic(h) + "|" + dpi + "|" + cls + "|" + title.ToString().Replace("|", "/"));
            }
            catch (Exception) { }
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    static int DistinctColors(Bitmap bmp)
    {
        var seen = new HashSet<int>();
        for (int y = 0; y < bmp.Height; y += 5)
            for (int x = 0; x < bmp.Width; x += 5)
                seen.Add(bmp.GetPixel(x, y).ToArgb());
        return seen.Count;
    }

    static Rectangle ParseCrop(string crop, int width, int height)
    {
        if (string.IsNullOrEmpty(crop)) return new Rectangle(0, 0, width, height);
        var parts = crop.Split(',');
        if (parts.Length != 4) throw new Exception("a crop is four numbers: x,y,width,height");
        var r = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
        var clamped = Rectangle.Intersect(r, new Rectangle(0, 0, width, height));
        if (clamped.Width <= 0 || clamped.Height <= 0) throw new Exception("that crop is outside the " + width + "x" + height + " picture");
        return clamped;
    }

    public static string CaptureScreen(string path, string crop)
    {
        SetProcessDPIAware();
        int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
        using (var full = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(full))
            {
                IntPtr dst = g.GetHdc();
                IntPtr src = GetDC(IntPtr.Zero);
                bool ok = BitBlt(dst, 0, 0, w, h, src, 0, 0, SRCCOPY | CAPTUREBLT);
                ReleaseDC(IntPtr.Zero, src);
                g.ReleaseHdc(dst);
                if (!ok) return "|false|bitblt-refused|0|0|0|" + w + "x" + h;
            }
            var rect = ParseCrop(crop, w, h);
            using (var cropBmp = full.Clone(rect, full.PixelFormat))
            {
                cropBmp.Save(path, ImageFormat.Png);
                return "|true|screen|" + DistinctColors(cropBmp) + "|" + rect.Width + "|" + rect.Height + "|" + w + "x" + h;
            }
        }
    }

    public static string CaptureWindow(long handle, string path, string crop, bool fallback, bool raise)
    {
        SetProcessDPIAware();
        var hwnd = new IntPtr(handle);
        if (IsIconic(hwnd)) return "|false|minimized|0|0|0|a minimized window has no pixels to copy";
        RECT r; GetWindowRect(hwnd, out r);
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return "|false|empty-rect|0|" + w + "|" + h + "|the window reports no size";
        uint dpi = DpiOf(hwnd);
        double scale = dpi > 0 ? dpi / 96.0 : 1.0;
        if (raise) { SetForegroundWindow(hwnd); Thread.Sleep(120); }
        using (var full = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            string method = "print";
            string note = "";
            using (var g = Graphics.FromImage(full))
            {
                IntPtr dc = g.GetHdc();
                bool ok = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT);
                g.ReleaseHdc(dc);
                if (!ok) { method = "print-refused"; }
            }
            int distinct = DistinctColors(full);
            if (distinct <= 1 && fallback)
            {
                method = "screen";
                note = "PrintWindow returned a blank picture, so this is the SCREEN at the window rectangle";
                using (var g = Graphics.FromImage(full))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr src = GetDC(IntPtr.Zero);
                    bool ok = BitBlt(dst, 0, 0, w, h, src, r.Left, r.Top, SRCCOPY | CAPTUREBLT);
                    ReleaseDC(IntPtr.Zero, src);
                    g.ReleaseHdc(dst);
                    if (!ok) return "|false|bitblt-refused|0|0|0|the screen fallback was refused too";
                }
                distinct = DistinctColors(full);
            }
            if (distinct <= 1) note = note == "" ? "the picture is one flat colour; some GPU-composited windows refuse both methods" : note;
            var rect = ParseCrop(crop, w, h);
            using (var cropBmp = full.Clone(rect, full.PixelFormat))
            {
                cropBmp.Save(path, ImageFormat.Png);
                return "|true|" + method + "|" + DistinctColors(cropBmp) + "|" + rect.Width + "|" + rect.Height + "|" + w + "x" + h + "|" + note + "|" + scale.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + dpi;
            }
        }
    }
}
'@

# System.Drawing is the one reference this needs. Windows PowerShell takes it by
# name; PowerShell 7 wants the assembly loaded first, so both spellings are tried
# and the failure is turned into a sentence instead of a stack trace.
$loaded = $false
try {
    Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
    $loaded = $true
} catch {
    try {
        Add-Type -AssemblyName System.Drawing
        Add-Type -TypeDefinition $code
        $loaded = $true
    } catch {
        $loaded = $false
        $message = $_.Exception.Message
    }
}
if (-not $loaded) {
    $fail = [ordered]@{ ok = $false; op = $request.op; code = 'NO_DRAWING'; message = 'This PowerShell cannot compile the GDI+ capture (' + $message + '). The capture needs Windows and System.Drawing.' }
    $fail | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}

$out = [ordered]@{ ok = $false; op = $request.op }

try {
if ($request.op -eq 'list') {
    $windows = @()
    foreach ($row in [ShotNative]::List()) {
        $p = $row.Split('|')
        $dpi = 0
        [void][int]::TryParse($p[7], [ref]$dpi)
        $scale = 1.0
        if ($dpi -gt 0) { $scale = [math]::Round($dpi / 96.0, 4) }
        $windows += [ordered]@{
            handle = [long]$p[0]
            pid = [int]$p[1]
            x = [int]$p[2]
            y = [int]$p[3]
            width = [int]$p[4]
            height = [int]$p[5]
            minimized = ($p[6] -eq 'True')
            scale = $scale
            className = $p[8]
            title = $p[9]
        }
    }
    $out.ok = $true
    $out.windows = $windows
}
elseif ($request.op -eq 'window') {
    $crop = ''
    if ($null -ne $request.crop) { $crop = [string]$request.crop }
    $fallback = $true
    if ($null -ne $request.fallback) { $fallback = [bool]$request.fallback }
    $raise = $false
    if ($null -ne $request.raise) { $raise = [bool]$request.raise }
    $verdict = [ShotNative]::CaptureWindow([long]$request.handle, [string]$request.out, $crop, $fallback, $raise)
    $p = $verdict.Split('|')
    $out.ok = ($p[1] -eq 'true')
    $out.method = $p[2]
    $out.distinct = [int]$p[3]
    $out.width = [int]$p[4]
    $out.height = [int]$p[5]
    $out.windowRect = $p[6]
    $out.note = $p[7]
    $scale = 1.0
    if ($p.Length -gt 8) { [void][double]::TryParse($p[8], [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$scale) }
    $out.scale = $scale
    if (-not $out.ok) { $out.code = $p[2]; $out.message = $p[6] }
}
elseif ($request.op -eq 'screen') {
    $crop = ''
    if ($null -ne $request.crop) { $crop = [string]$request.crop }
    $verdict = [ShotNative]::CaptureScreen([string]$request.out, $crop)
    $p = $verdict.Split('|')
    $out.ok = ($p[1] -eq 'true')
    $out.method = $p[2]
    $out.distinct = [int]$p[3]
    $out.width = [int]$p[4]
    $out.height = [int]$p[5]
    $out.screenRect = $p[6]
    if (-not $out.ok) { $out.code = $p[2]; $out.message = 'the screen capture was refused' }
}
else {
    $out.code = 'BAD_OP'
    $out.message = 'unknown operation: ' + $request.op
}
}
catch {
    $out = [ordered]@{ ok = $false; op = $request.op; code = 'FAILED'; message = $_.Exception.Message }
}

$out | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
`

/** A refusal a tool can print: a code, and a sentence a reader can act on. */
function refusal(code, message) {
  return { ok: false, code, message }
}

/**
 * Run one native operation.
 *
 * @param request - `{op: 'list'|'window'|'screen', ...}`. `out` is required for a capture.
 * @returns `{ ok, ... }` - the driver's own verdict, or a refusal naming what was missing.
 */
export async function runNative(request, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return refusal(
      'NOT_WINDOWS',
      'Native window capture is a Windows surface: it reads a window through the Win32 API (PrintWindow / BitBlt) and this host is ' + platform + '. Nothing is broken and nothing was written - use `shot_url` for a page, or capture the window with the operating system\'s own tool.',
    )
  }
  const powershell = options.powershell ?? resolvePowerShell({ env: options.env, platform })
  if (powershell === null) return refusal('NO_POWERSHELL', 'Windows always ships Windows PowerShell, and this host could not find one on PATH. Set DSH_SCREENSHOT_POWERSHELL to its executable.')
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-shot-native-'))
  const requestPath = path.join(workdir, 'request.json')
  const resultPath = path.join(workdir, 'result.json')
  const scriptPath = path.join(workdir, 'capture.ps1')
  try {
    await fsp.writeFile(requestPath, JSON.stringify(request), 'utf8')
    await fsp.writeFile(scriptPath, NATIVE_SCRIPT, 'utf8')
    const child = spawn(powershell.file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), DSH_SHOT_REQUEST: requestPath, DSH_SHOT_RESULT: resultPath },
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += String(chunk)
    })
    child.stdout.on('data', () => {})
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : NATIVE_TIMEOUT_MS
    const settled = await new Promise((done) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch (err) {
          /* already gone */
        }
        done({ timedOut: true, code: null })
      }, timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        done({ code: null, spawnError: err })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        done({ code })
      })
    })
    if (settled.spawnError) {
      return refusal('SPAWN_FAILED', 'The capture could not start ' + powershell.file + ': ' + String(settled.spawnError.message) + '. Set DSH_SCREENSHOT_POWERSHELL to a PowerShell that exists.')
    }
    if (settled.timedOut) return refusal('TIMEOUT', 'The capture did not finish within ' + String(timeoutMs) + ' ms and was stopped. A window that is not painting can hang PrintWindow: try `shot_screen` instead.')
    let text = ''
    try {
      text = await fsp.readFile(resultPath, 'utf8')
    } catch (err) {
      const why = stderr.trim() !== '' ? stderr.trim().split(/\r?\n/).slice(-4).join(' ') : 'it wrote no result file'
      return refusal('NO_RESULT', 'The capture driver exited (code ' + String(settled.code) + ') without a verdict: ' + why)
    }
    let parsed
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch (err) {
      return refusal('BAD_RESULT', 'The capture driver wrote something that is not JSON: ' + text.slice(0, 200))
    }
    return parsed
  } finally {
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The capturable windows, biggest first, as a list a person can pick from. */
export async function listWindows(options = {}) {
  const answer = await runNative({ op: 'list' }, options)
  if (answer.ok !== true) return answer
  const windows = Array.isArray(answer.windows) ? answer.windows : []
  const useful = windows
    .filter((entry) => typeof entry.title === 'string' && entry.title.trim() !== '')
    .filter((entry) => entry.width > 0 && entry.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height)
  return { ok: true, windows: useful, all: windows.length }
}

/** One window, by handle. */
export async function captureWindow({ handle, out, crop, fallback = true, raise = false }, options = {}) {
  if (!Number.isFinite(handle) || handle <= 0) return refusal('BAD_HANDLE', 'A window handle is a positive number, from `shot_window` with no window (the list) or from the title it matched.')
  const answer = await runNative({ op: 'window', handle, out, crop: crop ?? '', fallback, raise }, options)
  return answer
}

/** The screen, or one rectangle of it. */
export async function captureScreen({ out, crop }, options = {}) {
  return runNative({ op: 'screen', out, crop: crop ?? '' }, options)
}
