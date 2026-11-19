---
name: rust-ui-apps
description: Desktop applications with egui, eframe and wgpu - the App trait and run_native, Context being cheap to clone while Ui is per-frame, immediate-mode consequences (state lives in your struct), update() and request_repaint, CentralPanel/SidePanel/Window, Renderer::Wgpu versus Glow and wgpu::Backends::PRIMARY versus SECONDARY, the dev-build slowness that bites every egui app and the profile fix for it, where the binary lands, cross-compiling with --target, and the per-OS runtime dependency shape where the GPU driver is the runtime's business and not cargo's.
whenToUse: Use when building or debugging a Rust GUI with egui/eframe/wgpu, when the window is blank or does not repaint, when the app feels slow in a debug build, when choosing a renderer or a wgpu backend, when cross-compiling a GUI, or when a binary that builds fine fails to start on another machine.
---

# Desktop UIs with egui, eframe and wgpu

egui is **immediate mode**: every frame, the UI is rebuilt from your state by
running your code again. There are no widget objects to keep, no signals to
connect, and no retained tree to invalidate. The consequences of that one fact are
almost everything below.

## The frame is the unit

`eframe` owns the window and the event loop. It calls one method on one struct, and
the whole contract is its signature:
`fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame)`.

- **`&mut self`** is your whole application state. A widget cannot remember
  anything, so a checkbox's value is your `bool` field and a text field's contents
  are your `String`.
- **`ctx`** is the `egui::Context`: the shared runtime. It is cheap to **clone**
  (an `Arc` behind it), it is `Send + Sync`, and a clone can wake the UI from a
  worker thread.
- **`frame`** is eframe's per-frame handle: window information, storage, and - with
  the wgpu renderer - the `RenderState` that owns the device.

A `Ui` is a region of ONE frame. It is created by a panel or a window, handed to
your closure, and dropped when the closure returns. Storing a `Ui` in your struct
does not work; storing the values you read from it is the whole pattern.

## The smallest real app

```rust,ignore
use eframe::egui;

struct Counter {
    clicks: u32,
}

impl eframe::App for Counter {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Counter");
            if ui.button(format!("clicked {} times", self.clicks)).clicked() {
                self.clicks += 1;
            }
        });
    }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([420.0, 180.0]),
        ..Default::default()
    };
    // The closure returns a Result: `Ok(Box::new(app))`, or an error to abort startup.
    eframe::run_native(
        "counter",
        options,
        Box::new(|_cc| Ok(Box::new(Counter { clicks: 0 }))),
    )
}
```

Four details in that shape that are worth knowing rather than discovering:

1. **`run_native` returns `eframe::Result`**, which is `Result<(), eframe::Error>`.
   `fn main() -> eframe::Result` is the idiomatic signature; `?` works inside it.
2. **The app closure returns a `Result`** because creation can fail: `Ok(Box::new(app))`.
   The `CreationContext` argument (`cc` above) carries the `egui_ctx` and the
   persistence `Storage`, which is where a settings load belongs.
3. **`NativeOptions` is `..Default::default()`-constructed.** Everything you do not
   name keeps eframe's default, and that default is a working window.
4. **The window size is a `ViewportBuilder`**, not a tuple on `NativeOptions`
   (`with_inner_size`, `with_title`, `with_min_inner_size`, `with_resizable`).

## State lives in your struct, not in widgets

Panels claim space in the order they are added, and `CentralPanel` takes whatever
is left - which is why it goes LAST. `Window` is the one surface that is not a
panel: it floats above them, can be dragged and resized, and its visibility is
usually bound to a `bool` in your struct.

```rust,ignore
use eframe::egui;

struct Tool {
    name: String,
    progress: f32,
    show_help: bool,
}

impl eframe::App for Tool {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::SidePanel::left("side").show(ctx, |ui| {
            ui.label("Tool");
            ui.separator();
            ui.checkbox(&mut self.show_help, "Help");
        });
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.label(format!("{:.0}%", self.progress * 100.0));
        });
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.text_edit_singleline(&mut self.name);
            ui.add(egui::ProgressBar::new(self.progress));
            if ui.button("Advance").clicked() {
                self.progress = (self.progress + 0.1).min(1.0);
            }
        });
        // A `Window` floats; `.open` binds its visibility to a field of YOUR struct,
        // which is the only place UI state can live.
        if self.show_help {
            egui::Window::new("Help").open(&mut self.show_help).show(ctx, |ui| {
                ui.label("A window is not a widget and keeps no state of its own.");
            });
        }
        // An animation needs a reason to draw the next frame. Without this, a pane
        // repaints only on input, and a progress bar stops moving.
        if self.progress > 0.0 && self.progress < 1.0 {
            ctx.request_repaint_after(std::time::Duration::from_millis(16));
        }
    }
}
```

The widget vocabulary that covers most applications: `ui.label`, `ui.heading`,
`ui.button`, `ui.checkbox`, `ui.radio_value`, `ui.text_edit_singleline`,
`ui.text_edit_multiline`, `ui.add(egui::Slider::new(&mut x, 0.0..=1.0))`,
`ui.add(egui::ProgressBar::new(f))`, `ui.separator`, `ui.horizontal`,
`ui.vertical`, `egui::ScrollArea::vertical()`, `egui::Grid::new("form")`,
`egui::CollapsingHeader::new("advanced")`.

**Repainting is opt-in for animations and automatic for input.** eframe redraws
when something happens (a mouse move, a key, a resize); it does not redraw because
your state changed behind its back. `ctx.request_repaint()` asks for the next
frame immediately, `ctx.request_repaint_after(d)` asks for one after a delay -
which is what a poll should use instead of a busy loop.

## A worker thread must wake the UI

`Context` is `Send + Sync`, so a background thread can hold a clone and call
`request_repaint` when it has something to show. That is the whole integration
pattern: channel out, `request_repaint` in.

```rust,ignore
use eframe::egui;
use std::sync::mpsc::{channel, Receiver};

struct Loader {
    pending: Option<Receiver<String>>,
    result: String,
}

impl eframe::App for Loader {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(rx) = &self.pending {
            if let Ok(text) = rx.try_recv() {
                self.result = text;
                self.pending = None;
            }
        }
        egui::CentralPanel::default().show(ctx, |ui| {
            if ui.button("Load").clicked() && self.pending.is_none() {
                let (tx, rx) = channel::<String>();
                // `Context` is cheap to clone: the clone shares the one runtime behind
                // it, and it is `Send`, so a worker thread can wake the UI with it.
                let ctx = ctx.clone();
                std::thread::spawn(move || {
                    let text = "loaded".to_owned();
                    let _ = tx.send(text);
                    ctx.request_repaint();
                });
                self.pending = Some(rx);
            }
            ui.label(&self.result);
        });
    }
}
```

The alternative - blocking inside `update` - freezes the window, because `update`
runs on the event loop thread. There is no separate render thread to hide it.

## Choosing the renderer: Glow or Wgpu

eframe draws through one of two backends, chosen by Cargo features and then by a
field:

```toml
[dependencies]
# `wgpu` pulls the wgpu renderer; `glow` is eframe's default. Enabling both is
# normal: the choice is made at startup, not at compile time.
eframe = { version = "0.29", features = ["wgpu", "default_fonts"] }
egui = "0.29"
wgpu = "23"
```

| | `Renderer::Glow` | `Renderer::Wgpu` |
|---|---|---|
| underlying API | OpenGL (via glow) | Vulkan, Metal, DX12 (and GL/WebGPU as secondary) |
| weight | smaller, fewer moving parts | a larger dependency tree and a larger binary |
| drivers | needs a working GL driver; often fine on old hardware and inside VMs with software GL | needs a Vulkan/Metal/DX12 driver; enumerates adapters |
| what it unlocks | egui's own drawing | custom `wgpu` render passes, compute shaders, your own 3D pipeline |
| typical failure | a black window where GL is missing | "no adapter found" where nothing accelerated is present |

`egui_wgpu`'s configuration defaults to **`wgpu::Backends::PRIMARY`**, which is
Vulkan + Metal + DX12; `SECONDARY` (GL, DX11) is the fallback set. This matters
because the backend is a property of the wgpu setup, and in eframe 0.29 that lives
under `wgpu_options.wgpu_setup` (`WgpuSetup::CreateNew(..)`), not in the
long-standing `supported_backends` field - a name worth checking against the
version in your lock file rather than assuming.

```rust,ignore
fn native_options() -> eframe::NativeOptions {
    // Take the defaults and change ONLY the backend set: this is the field that
    // decides which drivers get asked for an adapter.
    let mut wgpu = eframe::egui_wgpu::WgpuConfiguration::default();
    if let eframe::egui_wgpu::WgpuSetup::CreateNew(setup) = &mut wgpu.wgpu_setup {
        setup.instance_descriptor.backends = wgpu::Backends::PRIMARY;
    }
    eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        wgpu_options: wgpu,
        ..Default::default()
    }
}
```

Under that layer, the wgpu shape is always the same three steps - `Instance` →
`request_adapter` → `request_device` - and each can fail for a reason that is
about the MACHINE, not your code: no driver, a headless session, a VM without
acceleration. wgpu also reads an environment override for the backend
(`WGPU_BACKEND=vulkan|dx12|metal|gl`), which is the first thing to try when a user
reports a window that will not open.

When a custom pass needs the device eframe is already using, ask `frame` for it
rather than creating a second `Device`:

```rust,ignore
impl eframe::App for GpuPane {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // `wgpu_render_state` is `Some` only when the pane was started with
        // `Renderer::Wgpu`. It hands out the SAME device and queue eframe draws with.
        if let Some(state) = frame.wgpu_render_state() {
            let device: &wgpu::Device = &state.device;
            let queue: &wgpu::Queue = &state.queue;
            let format: wgpu::TextureFormat = state.target_format;
            let _ = (device, queue, format);
        }
        egui::CentralPanel::default().show(ctx, |ui| ui.label("gpu pane"));
    }
}

struct GpuPane;
```

## The dev-build trap, and it is the one that bites

A debug build of an egui app is **dramatically slower than the release build** -
often several times slower, and sluggish enough to read as "egui is slow". The
cause is not egui: at `opt-level = 0` the tessellator, the layout pass and the
widget code are compiled without any of the optimizations they depend on for
smoothness.

The fix is one profile stanza, and it is the reason this section exists:

```toml
# Optimize your DEPENDENCIES, keep your own crate debuggable. This is the fix for
# "egui is slow in debug" and it works for any CPU-heavy dependency tree.
[profile.dev.package."*"]
opt-level = 2

# Optional: a middle ground for your own code (better runtime, still steppable).
[profile.dev]
opt-level = 1
```

`[profile.dev.package."*"]` applies to dependencies only, so your breakpoints and
line numbers in `src/` are untouched while egui, winit and the font stack are
optimized. The alternative - `[profile.dev] opt-level = 1` for everything - is
simpler and less effective; the two can be combined.

A release profile for a GUI usually wants the binary smaller rather than faster
still, because the frame cost is dominated by drawing:

```toml
[profile.release]
lto = "thin"
codegen-units = 1
strip = "symbols"
```

`strip = "symbols"` and readable release backtraces are a trade: keep `debug = 1`
while investigating, and strip at the point of shipping.

## Where the binary lands

| command | artefact |
|---|---|
| `cargo build` | `target/debug/<name>` (`<name>.exe` on Windows) |
| `cargo build --release` | `target/release/<name>` |
| `cargo build --release --target <triple>` | `target/<triple>/release/<name>` - **even when the triple is the host's own** |
| `cargo run --release` | builds, then runs the release artefact |

```sh
cargo run --release
cargo build --release
ls -lh target/release/my-app
```

On macOS eframe produces a bare Mach-O binary, not a `.app` bundle; a bundle needs
a packager (`cargo-bundle` and similar), which this plugin does not install. On
Windows the `.exe` needs the MSVC runtime unless the CRT is linked statically.

## Cross-compiling

Cross-compiling a GUI is harder than cross-compiling a library, because the
windowing and GPU stacks need the target's system libraries and a linker.

```sh
rustup target add x86_64-unknown-linux-gnu
cargo build --release --target x86_64-unknown-linux-gnu
```

That works only when a linker and the target's development libraries exist on the
build host. The honest rule:

- **Linux → Linux of another architecture**: possible with a cross toolchain and
  the target's X11/Wayland/GL packages (or `cross`, which runs the build in a
  container).
- **Windows → Linux**: needs a Linux linker and the Linux headers; a container is
  the practical route.
- **Anything → macOS**: needs the macOS SDK, which cannot be redistributed. Build
  macOS artefacts on macOS.
- **Anything → Windows**: `x86_64-pc-windows-msvc` from Linux is possible with
  `cargo-xwin`, but the MSVC CRT's licence is the reason it is awkward.

The linker is named per target through the environment:

```sh
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
  cargo build --release --target x86_64-unknown-linux-gnu
```

## Runtime dependencies per OS

| OS | what the app needs at RUN time | who supplies it |
|---|---|---|
| Linux | X11 or Wayland client libraries (`libxkbcommon`, `libwayland-client`, `libX11`), plus GL (`libGL`) for Glow or the Vulkan loader for Wgpu | the distribution; the eframe `x11` / `wayland` features decide which are used |
| Windows | nothing beyond the system DLLs; a DX12 or Vulkan driver for Wgpu | the OS, plus the GPU vendor's driver |
| macOS | nothing; Metal ships with the OS | the OS |

Two facts that explain most "it works on my machine" GUI reports:

1. **On Linux those libraries are loaded at RUNTIME**, by `dlopen` in winit, not
   linked at build time. So the build succeeds on a machine with the headers
   installed and the binary fails to start on one without the libraries, with an
   error naming the `.so` it could not open. A `.deb`/AppImage lists them; a bare
   binary does not.
2. **The GPU driver is the runtime's business, not cargo's.** No crate can install
   a driver, and no `cargo` command can prove that the machine has one that works.
   "No adapter found", a black window, or a crash inside `dlopen` of `libvulkan.so`
   are environment facts; the answers are a driver install, a different
   `WGPU_BACKEND`, or the Glow renderer as a fallback.

## What the tools answer

- `rust_status` reports the **targets** that are installed, which is what decides
  whether `--target …` can even start, and the notable crates the workspace
  declares (eframe, wgpu, winit), which tells you which renderer stack is in play.
- `cargo_build` reports the artefact PATH and its real size, plus elapsed time -
  the answer to "did the release binary land in `target/<triple>/release` or in
  `target/release`".
- `cargo_build` with `run: true` executes the binary: on a host with a display that
  proves the app starts, and on a headless one it fails with a windowing error,
  which is a fact about the host rather than about the build.
- `cargo_test` is for the logic behind the UI: put state transitions in plain
  functions and test those, because a GUI event loop is a poor test harness and
  this plugin ships no headless UI driver.

## What not to do

- Do not store a `Ui` or a widget in your struct. Store the value; rebuild the
  widget.
- Do not block inside `update`. Spawn, send the result over a channel, and
  `request_repaint` when it arrives.
- Do not add `CentralPanel` before the side panels: it consumes the remaining
  space, so the order is `SidePanel` / `TopBottomPanel` first, `CentralPanel` last.
- Do not animate with a sleep or a busy loop in `update`; use
  `request_repaint_after`.
- Do not judge egui's performance from a debug build. Apply the
  `[profile.dev.package."*"]` stanza first, then measure.
- Do not promise a cross-compiled GUI binary for an OS you did not build on. Test
  on the target, or say the binary is untested there.
- Do not read a "no adapter" error as a code bug. Check `WGPU_BACKEND`, the
  driver, and whether the session has a GPU at all.
