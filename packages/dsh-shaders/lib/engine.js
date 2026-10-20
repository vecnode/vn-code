/**
 * dsh-shaders — the browser this host already has, resolved once per call.
 *
 * Compiling GLSL needs a real GLSL compiler, and this pack ships none. The one
 * this machine already has is the Chromium-family browser a person installed:
 * through ANGLE it compiles GLSL ES 1.00 and ES 3.00 for real, and its software
 * rasterizer (SwiftShader) needs no GPU. Nothing is downloaded, nothing is
 * installed, and this module reaches no network.
 *
 * Resolved on every call rather than cached: a person who installs Chrome
 * mid-session should not have to restart the harness.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

/** Where a browser might be, before PATH is consulted. */
export function engineCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (value) => typeof value === 'string' && value !== '',
    )
    const out = []
    for (const root of roots) {
      out.push({ file: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' })
      out.push({ file: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' })
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      { file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
      { file: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
    ]
  }
  return [
    { file: '/usr/bin/google-chrome', kind: 'chrome' },
    { file: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { file: '/usr/bin/chromium', kind: 'chromium' },
    { file: '/usr/bin/chromium-browser', kind: 'chromium' },
    { file: '/usr/bin/microsoft-edge', kind: 'edge' },
  ]
}

function onPath(names, env, platform) {
  const dirs = String(env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((value) => value !== '')
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * The browser this host has, or `null`.
 *
 * `DSH_SHADERS_ENGINE` pins an executable PATH does not cover - a portable
 * Chromium, a nightly, a browser on a second drive.
 *
 * @returns `{ file, kind, source }` or `null`.
 */
export function resolveEngine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const override = env.DSH_SHADERS_ENGINE
  if (typeof override === 'string' && override !== '' && existsSync(override)) {
    return { file: override, kind: 'override', source: 'DSH_SHADERS_ENGINE' }
  }
  for (const candidate of engineCandidates(platform, env)) {
    if (existsSync(candidate.file)) return { ...candidate, source: 'install' }
  }
  const names =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const found = onPath(names, env, platform)
  if (found !== null) return { file: found, kind: 'path', source: 'PATH' }
  return null
}

/**
 * The engine's argv: headless, one throwaway profile, no network but loopback.
 *
 * `--disable-gpu` is deliberately ABSENT, and that is the whole reason this row
 * works. The pack's page-render path passes it; measured, it makes
 * `getContext('webgl')` return null. Without it, plus `--use-angle=swiftshader`,
 * a headless browser on a GPU-less machine reports WebGL 2.0 over
 * "ANGLE (Google, Vulkan ... SwiftShader Device (Subzero))" and compiles.
 */
export function buildArgs({ profileDir, width = 64, height = 64 }) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    // Every name fails except loopback: nothing this row compiles can fetch.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--window-size=' + String(width) + ',' + String(height),
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    '--password-store=basic',
    '--use-mock-keychain',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--incognito',
    'about:blank',
  ]
}

/** Parse a `DevToolsActivePort` file: the port on line 1, the ws path on line 2. */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const port = Number(lines[0])
  const wsPath = (lines[1] ?? '').trim()
  if (!Number.isFinite(port) || port <= 0 || wsPath === '') return null
  return { port, wsPath }
}

/**
 * Which WebGL context a dialect compiles in, and the extensions that must be
 * asked for BEFORE the shader is handed over.
 *
 * Every wrapper dialect (`shadertoy`, `shader-skills`, `module`) is assembled
 * with `#version 300 es`, so it needs a WebGL2 context - measured: handing an
 * ES 3.00 string to a WebGL1 context fails with
 * "ERROR: 0:1: '' : unsupported shader version 300", which says nothing about
 * the shader and everything about the context.
 *
 * A Radiant `es100` fragment that calls `fwidth` fails with "extension is not
 * supported / no matching overloaded function" until
 * `getExtension('OES_standard_derivatives')` has been called on the context, and
 * then it compiles. Two of that corpus's pages depend on exactly that, so a
 * compile path that skipped it would report two good shaders as broken.
 */
export function contextFor(dialect) {
  if (dialect === 'es300' || dialect === 'shadertoy' || dialect === 'shader-skills' || dialect === 'module') {
    return { name: 'webgl2', extensions: ['EXT_color_buffer_float', 'OES_texture_float_linear'] }
  }
  return { name: 'webgl', extensions: ['OES_standard_derivatives', 'EXT_shader_texture_lod', 'EXT_frag_depth', 'WEBGL_draw_buffers'] }
}
