// actions.js — process actions + startup/users/services providers.
// Linux edition. Uses Node child_process + fs only, plus systeminformation, os, electron.shell.
// Every exported function is wrapped in try/catch so they don't throw.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let si = null;
try {
  si = require('systeminformation');
} catch (_) {
  si = null;
}

// --- helpers --------------------------------------------------------------

// Run a command and collect its output. Resolves with
// { ok, code, stdout, stderr, error } and never rejects.
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, Object.assign({ windowsHide: true }, opts || {}));
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: String(e && e.message ? e.message : e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => { stderr += d; });
      }
    } catch (_) { /* ignore stream wiring errors */ }

    child.on('error', (e) => {
      finish({ ok: false, code: null, stdout, stderr, error: String(e && e.message ? e.message : e) });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, error: code === 0 ? undefined : (stderr.trim() || ('exit code ' + code)) });
    });
  });
}

// --- process actions ------------------------------------------------------

// kill(pid, force) — SIGKILL when force, else SIGTERM. Returns {ok,error}.
function kill(pid, force) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'Invalid pid' };
    }
    process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// setPriority(pid, nice) — renice the process (works without sudo for your own).
async function setPriority(pid, nice) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'Invalid pid' };
    }
    let niceVal = Number(nice);
    if (!Number.isFinite(niceVal)) niceVal = 0;
    niceVal = Math.round(niceVal);
    if (niceVal < -20) niceVal = -20;
    if (niceVal > 19) niceVal = 19;

    const res = await run('renice', [String(niceVal), '-p', String(n)]);
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || 'renice failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// reveal(path) — show item in file manager.
// Tries: nautilus --select, dolphin --select, thunar, xdg-open (dir).
function reveal(targetPath) {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      return { ok: false, error: 'No path provided' };
    }
    const dir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
      ? targetPath
      : path.dirname(targetPath);

    // Try common file managers with "select" support
    const fms = [
      { cmd: 'nautilus', args: ['--select', targetPath] },
      { cmd: 'dolphin', args: ['--select', targetPath] },
      { cmd: 'nemo', args: [targetPath] },
      { cmd: 'thunar', args: [dir] },
      { cmd: 'pcmanfm', args: [dir] },
      { cmd: 'xdg-open', args: [dir] },
    ];

    for (const fm of fms) {
      try {
        const child = spawn(fm.cmd, fm.args, { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true };
      } catch (_) { /* try next */ }
    }
    return { ok: false, error: 'No file manager found' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// --- startup items provider -----------------------------------------------

// Detect desktop environment for startup item locations.
function getDesktopEnv() {
  const de = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
  if (de.includes('gnome') || de.includes('unity') || de.includes('cinnamon') || de.includes('mate') || de.includes('budgie')) return 'gnome';
  if (de.includes('kde')) return 'kde';
  if (de.includes('xfce')) return 'xfce';
  if (de.includes('lxde') || de.includes('lxqt')) return 'lxde';
  return 'generic';
}

// startupItems() — list autostart .desktop files + systemd user units.
async function startupItems() {
  try {
    const home = os.homedir();
    const items = [];
    const seen = new Set();

    // 1) XDG autostart .desktop files
    const autostartDirs = [
      path.join(home, '.config', 'autostart'),
      '/etc/xdg/autostart',
    ];
    for (const dir of autostartDirs) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop'));
        for (const file of files) {
          try {
            const full = path.join(dir, file);
            if (seen.has(full)) continue;
            seen.add(full);
            const text = fs.readFileSync(full, 'utf8');
            const nameMatch = text.match(/^Name=(.+)$/m);
            const execMatch = text.match(/^Exec=(.+)$/m);
            const hidden = /^Hidden=true/m.test(text);
            if (hidden || !execMatch) continue;
            const noDisplay = /^X-GNOME-Autostart-Enabled=false/m.test(text) ||
              /^NoDisplay=true/m.test(text);
            const enabled = !noDisplay;
            items.push({
              name: nameMatch ? nameMatch[1].trim() : file.replace('.desktop', ''),
              label: file.replace('.desktop', ''),
              path: full,
              type: 'XDG Autostart',
              scope: dir.startsWith(home) ? 'user' : 'system',
              enabled,
              impact: '—',
            });
          } catch (_) { /* skip */ }
        }
      } catch (_) { /* dir doesn't exist */ }
    }

    // 2) systemd user units that are enabled
    try {
      const res = await run('systemctl', ['--user', 'list-unit-files', '--type=service', '--state=enabled', '--no-pager', '--plain']);
      if (res.ok && res.stdout) {
        const lines = res.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^(\S+\.service)\s+enabled/);
          if (!match) continue;
          const unitName = match[1];
          if (seen.has('systemd-user:' + unitName)) continue;
          seen.add('systemd-user:' + unitName);
          items.push({
            name: unitName.replace('.service', ''),
            label: unitName,
            path: '',
            type: 'systemd user',
            scope: 'user',
            enabled: true,
            impact: '—',
          });
        }
      }
    } catch (_) { /* systemctl not available */ }

    // 3) systemd system units enabled at boot
    try {
      const res = await run('systemctl', ['list-unit-files', '--type=service', '--state=enabled', '--no-pager', '--plain']);
      if (res.ok && res.stdout) {
        const lines = res.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^(\S+\.service)\s+enabled/);
          if (!match) continue;
          const unitName = match[1];
          if (seen.has('systemd-system:' + unitName)) continue;
          seen.add('systemd-system:' + unitName);
          // Skip user units (already listed above) and basic/target units
          if (unitName.includes('@.service')) continue;
          items.push({
            name: unitName.replace('.service', ''),
            label: unitName,
            path: '',
            type: 'systemd system',
            scope: 'system',
            enabled: true,
            impact: '—',
          });
        }
      }
    } catch (_) { /* ignore */ }

    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  } catch (e) {
    return [];
  }
}

// Enable/disable a startup item.
async function setStartupEnabled(label, type, enabled) {
  try {
    if (!label) return { ok: false, error: 'Missing service label' };

    // XDG autostart: toggle Hidden/NoDisplay in the .desktop file
    if (type === 'XDG Autostart') {
      const home = os.homedir();
      const userDir = path.join(home, '.config', 'autostart');
      const filePath = path.join(userDir, label + '.desktop');

      // If the file doesn't exist in user dir, create an override
      if (!fs.existsSync(filePath)) {
        // Find the system file
        const sysPath = path.join('/etc/xdg/autostart', label + '.desktop');
        if (fs.existsSync(sysPath)) {
          fs.copyFileSync(sysPath, filePath);
        } else {
          return { ok: false, error: 'Autostart file not found' };
        }
      }

      let text = fs.readFileSync(filePath, 'utf8');
      if (enabled) {
        text = text.replace(/^Hidden=true/m, 'Hidden=false');
        text = text.replace(/^X-GNOME-Autostart-Enabled=false/m, 'X-GNOME-Autostart-Enabled=true');
        if (!/^X-GNOME-Autostart-Enabled=/m.test(text)) {
          text += '\nX-GNOME-Autostart-Enabled=true\n';
        }
      } else {
        if (/^Hidden=true/m.test(text)) {
          // already disabled
        } else if (/^X-GNOME-Autostart-Enabled=/m.test(text)) {
          text = text.replace(/^X-GNOME-Autostart-Enabled=true/m, 'X-GNOME-Autostart-Enabled=false');
        } else {
          text += '\nX-GNOME-Autostart-Enabled=false\n';
        }
      }
      fs.writeFileSync(filePath, text, 'utf8');
      return { ok: true };
    }

    // systemd units
    const isUser = type === 'systemd user';
    const verb = enabled ? 'enable' : 'disable';
    const args = isUser
      ? ['--user', verb, label]
      : [verb, label];

    const res = await run('systemctl', args);
    if (res.ok) return { ok: true };

    // For system units, try with pkexec (polkit elevation)
    if (!isUser) {
      const adminRes = await run('pkexec', ['systemctl', verb, label]);
      if (adminRes.ok) return { ok: true };
      return { ok: false, error: adminRes.error || res.error || 'Failed' };
    }

    return { ok: false, error: res.error || 'Failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// --- users provider --------------------------------------------------------

// users() — aggregate running processes per user into UserSession[].
async function users() {
  try {
    const currentUser = (() => {
      try { return os.userInfo().username; } catch (_) { return process.env.USER || ''; }
    })();

    let list = [];
    if (si && typeof si.processes === 'function') {
      try {
        const procs = await si.processes();
        list = (procs && Array.isArray(procs.list)) ? procs.list : [];
      } catch (_) {
        list = [];
      }
    }

    let cores = 1;
    try {
      const cpu = await si.cpu();
      cores = Number(cpu && cpu.cores) || (os.cpus() ? os.cpus().length : 1) || 1;
    } catch (_) {
      cores = (os.cpus() ? os.cpus().length : 1) || 1;
    }

    const byUser = new Map();
    for (const p of list) {
      if (!p) continue;
      const user = (p.user && String(p.user).trim()) || 'unknown';
      let agg = byUser.get(user);
      if (!agg) {
        agg = { user, pid: null, cpu: 0, memBytes: 0, processes: 0, status: 'Disconnected' };
        byUser.set(user, agg);
      }
      const cpu = Number(p.cpu);
      if (Number.isFinite(cpu)) agg.cpu += cpu;
      const rssKb = Number(p.memRss);
      if (Number.isFinite(rssKb)) agg.memBytes += rssKb * 1024;
      agg.processes += 1;
    }

    const out = [];
    for (const agg of byUser.values()) {
      agg.cpu = Math.round((agg.cpu / cores) * 10) / 10;
      agg.status = (currentUser && agg.user === currentUser) ? 'Active' : 'Disconnected';
      out.push(agg);
    }

    out.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'Active' ? -1 : 1;
      return b.processes - a.processes;
    });

    return out;
  } catch (e) {
    return [];
  }
}

// --- services provider -----------------------------------------------------

// services() — list systemd services.
async function services() {
  try {
    const out = [];

    // System services
    const sysRes = await run('systemctl', [
      'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend',
    ]);
    if (sysRes.ok && sysRes.stdout) {
      const lines = sysRes.stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const unitName = parts[0];
        if (!unitName.endsWith('.service')) continue;
        const active = parts[2]; // active, inactive, failed
        const sub = parts[3]; // running, dead, exited, etc.
        const label = unitName.replace('.service', '');
        out.push({
          label,
          pid: null, // systemctl doesn't always show PID in list-units
          status: (active === 'active') ? 'running' : 'stopped',
          type: 'system',
        });
      }
    }

    // User services
    const userRes = await run('systemctl', [
      '--user', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend',
    ]);
    if (userRes.ok && userRes.stdout) {
      const lines = userRes.stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const unitName = parts[0];
        if (!unitName.endsWith('.service')) continue;
        const active = parts[2];
        const label = unitName.replace('.service', '');
        out.push({
          label,
          pid: null,
          status: (active === 'active') ? 'running' : 'stopped',
          type: 'user',
        });
      }
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  } catch (e) {
    return [];
  }
}

// toggleService(label, on) — start/stop a systemd service. Returns {ok,error}.
async function toggleService(label, on) {
  try {
    if (!label || typeof label !== 'string') {
      return { ok: false, error: 'No service label provided' };
    }
    const unitName = label.endsWith('.service') ? label : label + '.service';
    const verb = on ? 'start' : 'stop';

    // Try user-level first
    const userRes = await run('systemctl', ['--user', verb, unitName]);
    if (userRes.ok) return { ok: true };

    // Fall back to system-level
    const sysRes = await run('systemctl', [verb, unitName]);
    if (sysRes.ok) return { ok: true };

    // Try with pkexec for permission issues
    const adminRes = await run('pkexec', ['systemctl', verb, unitName]);
    if (adminRes.ok) return { ok: true };

    return { ok: false, error: adminRes.error || sysRes.error || 'Service toggle failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// --- app icon resolution ---------------------------------------------------

// appIconDataUrl(iconPath) — convert an icon file path to a PNG data URL.
// On Linux, icons are already PNG/SVG; we just read and base64-encode them.
// For SVGs, we return them as-is (Electron can render SVG data URLs).
async function appIconDataUrl(iconPath) {
  try {
    if (!iconPath || typeof iconPath !== 'string') return '';
    if (!fs.existsSync(iconPath)) return '';

    const ext = path.extname(iconPath).toLowerCase();
    if (ext === '.svg') {
      const buf = fs.readFileSync(iconPath);
      if (buf && buf.length) return 'data:image/svg+xml;base64,' + buf.toString('base64');
    }
    if (ext === '.png' || ext === '.xpm') {
      const buf = fs.readFileSync(iconPath);
      if (buf && buf.length) return 'data:image/png;base64,' + buf.toString('base64');
    }
    // For other formats, try reading as raw and hoping for the best
    const buf = fs.readFileSync(iconPath);
    if (buf && buf.length) return 'data:image/png;base64,' + buf.toString('base64');
    return '';
  } catch (_) {
    return '';
  }
}

// --- run task --------------------------------------------------------------

// runTask(command) — launch a user-supplied command (detached).
function runTask(command) {
  return new Promise((resolve) => {
    try {
      if (!command || typeof command !== 'string' || !command.trim()) {
        resolve({ ok: false, error: 'Enter a command to run' });
        return;
      }
      const child = spawn('/bin/sh', ['-lc', command.trim()], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (e) => {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      });
      child.unref();
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

module.exports = {
  kill,
  setPriority,
  reveal,
  startupItems,
  setStartupEnabled,
  appIconDataUrl,
  runTask,
  users,
  services,
  toggleService,
};
