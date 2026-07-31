<div align="center">

<img src="assets/icon.png" width="120" alt="Task Manager icon" />

# Task Manager for Linux

**A Windows‑style Task Manager for Linux — fast, dense, and it shows what you actually want to see.**

[![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](#)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#-license)

</div>

---

GNOME System Monitor is fine, but it never quite scratched the itch — so this is the
Task Manager I wanted on Linux. Processes in a tight, sortable table grouped into
**Apps / Background / System**, live **CPU · Memory · Disk · Network · GPU** columns,
and a Performance tab with per‑core graphs. The layout is borrowed from Windows 11.

## Features

- **Processes** — grouped into Apps / Background / System with app icons from `.desktop` files,
  per‑group CPU/Memory/Network totals, sortable columns, search, and a right‑click menu
  (End task, Set priority, Open file location).
- **Performance** — live graphs for CPU (a grid per logical core), Memory, Disk, Network
  and GPU, a "Top processes" list, and the details that matter: load average, swap,
  cached memory, uptime, threads…
- **Memory done right** — reads `/proc/meminfo` directly to show accurate MemTotal, MemAvailable,
  Buffers+Cached, and Swap — matching what `htop` and GNOME System Monitor display.
- **Real disk & network rates** — derived from system counters; per‑process disk I/O via
  `/proc/<pid>/io`, per‑process network via `/proc/<pid>/net/dev`.
- **GPU utilization** — NVIDIA via `nvidia-smi`, AMD via sysfs (`gpu_busy_percent`).
- **Startup apps** — see your XDG autostart `.desktop` files and systemd user/system units,
  toggle them on or off.
- **Users · Details · Services** tabs, and a **Run new task** launcher.
- **Services** — systemd user and system services, start/stop via right‑click.

## Getting started

You'll need [Node.js](https://nodejs.org/) 18+ and a Linux distribution with systemd.

**Run from source**

```bash
git clone <repo-url>
cd Task-Manager-for-Linux
npm install
npm start
```

**Build packages**

```bash
./scripts/build.sh
```

…or pick a target:

```bash
npm run dist:appimage    # universal AppImage
npm run dist:deb         # Debian/Ubuntu .deb
npm run dist:rpm         # Fedora/RHEL .rpm
```

The packages land in `dist/`.

> **Heads up:** Electron downloads its runtime from GitHub during `npm install`. If you use a
> DNS‑level blocker (AdGuard, Pi‑hole, a VPN…), allow `github.com` and
> `objects.githubusercontent.com`, or pause it for the install. If you can't unblock GitHub,
> use a mirror:
> ```bash
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
> ```

## Notes & limitations

- **GPU support** depends on your hardware: NVIDIA requires `nvidia-smi` in PATH, AMD
  requires sysfs access to `/sys/class/drm/card*/device/gpu_busy_percent`, Intel has
  limited support.
- **Per‑process disk I/O** reads `/proc/<pid>/io` — available for processes you own without
  root. System processes owned by root may show 0.
- **Per‑process network** reads `/proc/<pid>/net/dev` — available for all your processes
  without sudo, but aggregated across all interfaces (no per‑interface breakdown).
- **Startup toggle** for system systemd services requires `pkexec` (polkit) — you'll get
  a password prompt.
- **Service toggle** tries user‑level `systemctl --user` first, then falls back to
  system‑level with `pkexec` elevation.
- **App icons** are resolved from `.desktop` files via the hicolor icon theme hierarchy.
  If an app doesn't have a `.desktop` file or its icon isn't in the theme, a generic
  glyph is shown instead.

## Project structure

<details>
<summary>Click to expand</summary>

```
src/
  main/                 Electron main process
    main.js             window + app lifecycle + menu (Linux: frameless)
    ipc.js              IPC handlers
    preload.js          window.api bridge
    actions.js          kill / priority / startup / services / icons (Linux: systemd + .desktop)
    metrics/
      processes.js      process list (+ per-process disk I/O + network via /proc)
      system.js         CPU / memory / disk / net / GPU stats (Linux: /proc/meminfo, nvidia-smi)
  renderer/             UI (vanilla JS, no framework)
    index.html
    styles/             design tokens + per-area CSS
    js/
      app.js            bootstrap, sidebar, polling loop
      state.js          shared store
      format.js         number/byte formatting
      icons.js          lazy app-icon loader
      components/       sparkline, line chart, context menu, titlebar (Linux: window controls)
      views/            processes, performance, details, startup, users, services
assets/                 app icon
image/                  screenshots for this README
scripts/build.sh        build helper
```

</details>

## Built with

Electron and plain JS/HTML/CSS — no front‑end framework, no bundler. System data comes from
[`systeminformation`](https://systeminformation.io/) plus Linux-native sources
(`/proc/meminfo`, `/proc/<pid>/io`, `/proc/<pid>/net/dev`, `/proc/stat`, `systemctl`,
`nvidia-smi`, `.desktop` files, icon theme hierarchy).

## License

[MIT](LICENSE) — do whatever you like.
