// processes.js — process enumeration + classification (main process).
// Linux edition. Exports async list() -> Process[], and classify() helper.
// Uses systeminformation si.processes() + si.cpu() (logical cores), os.userInfo().
// Per-process network from /proc/<pid>/net/dev deltas.
// Friendly names from /proc/<pid>/comm + .desktop file resolution.
// Icons from .desktop Icon= fields resolved via icon theme directories.

const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function execText(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeout || 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch (_) { resolve(null); }
  });
}

// ---- Per-process network throughput via /proc/<pid>/net/dev deltas ----
// Reads cumulative bytes from /proc/<pid>/net/dev (all interfaces), computes
// per-second rate from delta between polls.
let _netPrev = null; // { t, map: Map<pid, totalBytes> }

async function getNetRates() {
  const rates = new Map();
  try {
    // Get all PIDs from /proc
    const procDir = '/proc';
    const entries = fs.readdirSync(procDir).filter((e) => /^\d+$/.test(e));
    const cur = new Map();
    const now = Date.now();

    for (const pid of entries) {
      try {
        const text = fs.readFileSync(`${procDir}/${pid}/net/dev`, 'utf8');
        if (!text) continue;
        let total = 0;
        const lines = text.split('\n');
        for (let i = 2; i < lines.length; i++) { // skip header lines
          const parts = lines[i].trim().split(/[\s:]+/);
          if (parts.length < 10) continue;
          const iface = parts[0];
          if (iface === 'lo') continue;
          total += (parseInt(parts[1], 10) || 0) + (parseInt(parts[9], 10) || 0);
        }
        if (total > 0) cur.set(parseInt(pid, 10), total);
      } catch (_) { /* permission denied or pid vanished */ }
    }

    if (_netPrev) {
      const dt = (now - _netPrev.t) / 1000;
      if (dt > 0) {
        cur.forEach((total, pid) => {
          const prev = _netPrev.map.get(pid);
          if (prev != null) {
            const r = (total - prev) / dt;
            if (r > 0) rates.set(pid, r);
          }
        });
      }
    }
    _netPrev = { t: now, map: cur };
  } catch (_) { /* ignore */ }
  return rates;
}

// ---- Per-process disk I/O from /proc/<pid>/io ----
// On Linux this is available without root for processes you own.
let _diskPrev = null; // { t, map: Map<pid, {readBytes, writeBytes}> }

async function getDiskRates() {
  const rates = new Map(); // pid -> { readBytesSec, writeBytesSec }
  try {
    const procDir = '/proc';
    const entries = fs.readdirSync(procDir).filter((e) => /^\d+$/.test(e));
    const cur = new Map();
    const now = Date.now();

    for (const pid of entries) {
      try {
        const text = fs.readFileSync(`${procDir}/${pid}/io`, 'utf8');
        if (!text) continue;
        let readBytes = 0, writeBytes = 0;
        const readMatch = text.match(/^read_bytes:\s+(\d+)/m);
        const writeMatch = text.match(/^write_bytes:\s+(\d+)/m);
        if (readMatch) readBytes = parseInt(readMatch[1], 10);
        if (writeMatch) writeBytes = parseInt(writeMatch[1], 10);
        cur.set(parseInt(pid, 10), { readBytes, writeBytes });
      } catch (_) { /* permission denied or pid vanished */ }
    }

    if (_diskPrev) {
      const dt = (now - _diskPrev.t) / 1000;
      if (dt > 0) {
        cur.forEach((io, pid) => {
          const prev = _diskPrev.map.get(pid);
          if (prev) {
            const readRate = Math.max(0, (io.readBytes - prev.readBytes) / dt);
            const writeRate = Math.max(0, (io.writeBytes - prev.writeBytes) / dt);
            if (readRate > 0 || writeRate > 0) {
              rates.set(pid, { readBytesSec: readRate, writeBytesSec: writeRate });
            }
          }
        });
      }
    }
    _diskPrev = { t: now, map: cur };
  } catch (_) { /* ignore */ }
  return rates;
}

// ---- cached logical core count ----
let _logicalCores = 0;
async function getLogicalCores() {
  if (_logicalCores > 0) return _logicalCores;
  try {
    const cpu = await si.cpu();
    _logicalCores = Number(cpu && cpu.cores) || (os.cpus() ? os.cpus().length : 0) || 1;
  } catch (_) {
    _logicalCores = (os.cpus() ? os.cpus().length : 0) || 1;
  }
  return _logicalCores;
}

// ---- cached current username ----
let _currentUser = null;
function getCurrentUser() {
  if (_currentUser !== null) return _currentUser;
  try {
    _currentUser = (os.userInfo().username || '').trim();
  } catch (_) {
    _currentUser = '';
  }
  return _currentUser;
}

// ---- .desktop file cache for friendly names and icons ----
const _desktopCache = new Map(); // binary name -> { name, icon }
const _desktopIconCache = new Map(); // icon name -> resolved file path (or '')
const _desktopPaths = [];
let _desktopPathsBuilt = false;

function buildDesktopPaths() {
  if (_desktopPathsBuilt) return;
  _desktopPathsBuilt = true;
  const home = os.homedir();
  const xdgDataDirs = process.env.XDG_DATA_DIRS || '/usr/share:/usr/local/share';
  const dirs = xdgDataDirs.split(':');
  dirs.unshift(path.join(home, '.local', 'share'));
  for (const dir of dirs) {
    _desktopPaths.push(path.join(dir, 'applications'));
  }
}

function loadDesktopFiles() {
  if (_desktopCache.size > 0) return;
  buildDesktopPaths();
  for (const dir of _desktopPaths) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop'));
      for (const file of files) {
        try {
          const text = fs.readFileSync(path.join(dir, file), 'utf8');
          const nameMatch = text.match(/^Name=(.+)$/m);
          const execMatch = text.match(/^Exec=(.+)$/m);
          const iconMatch = text.match(/^Icon=(.+)$/m);
          const noDisplay = /^NoDisplay=true/m.test(text);
          if (noDisplay || !execMatch) continue;

          const execCmd = execMatch[1].trim().split(/\s+/)[0];
          const binaryName = path.basename(execCmd);
          const entry = {
            name: nameMatch ? nameMatch[1].trim() : binaryName,
            icon: iconMatch ? iconMatch[1].trim() : '',
          };

          // Map both the binary name and the full exec path
          if (!_desktopCache.has(binaryName)) _desktopCache.set(binaryName, entry);
          if (execCmd.includes('/') && !_desktopCache.has(execCmd)) _desktopCache.set(execCmd, entry);
        } catch (_) { /* skip unreadable file */ }
      }
    } catch (_) { /* dir doesn't exist */ }
  }
}

// Resolve an icon name to a file path via hicolor icon theme.
function resolveIconPath(iconName) {
  if (!iconName) return '';
  // Already a full path
  if (iconName.startsWith('/') && fs.existsSync(iconName)) return iconName;
  if (_desktopIconCache.has(iconName)) return _desktopIconCache.get(iconName);

  const home = os.homedir();
  const iconDirs = [
    path.join(home, '.icons'),
    path.join(home, '.local', 'share', 'icons'),
    '/usr/share/icons/hicolor',
    '/usr/share/icons',
    '/usr/share/pixmaps',
  ];
  const sizes = ['48x48', '64x64', '32x32', '256x256', '128x128', 'scalable'];
  const categories = ['apps', 'categories', 'devices'];
  const extensions = ['png', 'svg', 'xpm'];

  for (const base of iconDirs) {
    // pixmaps is flat
    if (base.includes('pixmaps')) {
      for (const ext of extensions) {
        const p = path.join(base, `${iconName}.${ext}`);
        if (fs.existsSync(p)) { _desktopIconCache.set(iconName, p); return p; }
      }
      continue;
    }
    for (const size of sizes) {
      for (const cat of categories) {
        for (const ext of extensions) {
          const p = path.join(base, size, cat, `${iconName}.${ext}`);
          if (fs.existsSync(p)) { _desktopIconCache.set(iconName, p); return p; }
        }
      }
    }
  }
  _desktopIconCache.set(iconName, '');
  return '';
}

// ---- Derive a friendly process name ----
function deriveName(item) {
  const cmd = (item && item.command) || '';
  const rawName = (item && item.name) || '';
  const p = (item && item.path) || '';

  // 1) Try .desktop lookup by binary name
  loadDesktopFiles();
  if (cmd) {
    const binary = path.basename(cmd.split(/\s+/)[0] || cmd);
    const entry = _desktopCache.get(binary);
    if (entry) return entry.name;
  }

  // 2) /proc/<pid>/comm (short, clean name)
  if (rawName && rawName.length <= 15) return rawName;

  // 3) Command's first token, basename
  if (cmd) {
    const tok = cmd.split(/\s+/)[0] || cmd;
    const base = path.basename(tok);
    if (base) return base;
  }

  // 4) si's name
  return rawName || '';
}

// Resolve the .desktop icon for a process (returns an absolute path or '').
function resolveIcon(item) {
  const cmd = (item && item.command) || '';
  if (!cmd) return '';
  loadDesktopFiles();
  const binary = path.basename(cmd.split(/\s+/)[0] || cmd);
  const entry = _desktopCache.get(binary);
  if (entry && entry.icon) return resolveIconPath(entry.icon);
  return '';
}

// ---- Process classification ----
const SYSTEM_PATH_PREFIXES = [
  '/usr/lib/systemd', '/usr/sbin', '/sbin', '/usr/bin/',
  '/boot', '/snap/',
];

function classify(item, currentUser) {
  const user = (item && item.user) || '';
  const execPath = (item && item.path) || '';
  const cmd = (item && item.command) || '';

  // System: root-owned, or executable lives under a system directory
  if (user === 'root' || user === 'nobody') return 'system';
  for (let i = 0; i < SYSTEM_PATH_PREFIXES.length; i++) {
    if (execPath && execPath.startsWith(SYSTEM_PATH_PREFIXES[i])) return 'system';
  }

  // Check if this process has a .desktop file — if so, it's an app
  if (cmd) {
    loadDesktopFiles();
    const binary = path.basename(cmd.split(/\s+/)[0] || cmd);
    const entry = _desktopCache.get(binary);
    if (entry && entry.name) {
      // Distinguish GUI apps from background services
      const ownedByUser = !!currentUser && user === currentUser;
      if (ownedByUser) {
        // Filter out helper/renderer processes
        const lower = cmd.toLowerCase();
        const isHelper = /helper|renderer|gpu-process|utility|zygote|--type=/.test(lower);
        if (!isHelper) return 'app';
      }
    }
  }

  return 'background';
}

// Convert one si process list item into the Process shape.
function toProcess(item, logicalCores, currentUser) {
  const rawCpu = Number(item.cpu);
  const cpu = Number.isFinite(rawCpu) && logicalCores > 0 ? rawCpu / logicalCores : 0;

  const rss = Number(item.memRss); // KB
  const memBytes = Number.isFinite(rss) ? rss * 1024 : 0;

  const memPercent = Number(item.mem);

  return {
    pid: Number(item.pid),
    ppid: Number(item.parentPid) || 0,
    name: deriveName(item) || String(item.name || `pid ${item.pid}`),
    cpu: Number.isFinite(cpu) ? cpu : 0,
    memBytes,
    memPercent: Number.isFinite(memPercent) ? memPercent : 0,
    user: (item.user || '').trim(),
    state: item.state || 'unknown',
    nice: Number.isFinite(Number(item.nice)) ? Number(item.nice) : 0,
    started: item.started || null,
    path: item.path || '',
    iconPath: resolveIcon(item),  // absolute path to icon file (or '')
    command: item.command || '',
    netBytesSec: 0,
    diskReadBytesSec: 0,
    diskWriteBytesSec: 0,
    type: classify(item, currentUser),
  };
}

// Public: enumerate processes. Returns [] on failure.
async function list() {
  try {
    const logicalCores = await getLogicalCores();
    const currentUser = getCurrentUser();
    const [data, netRates, diskRates] = await Promise.all([
      si.processes(),
      getNetRates(),
      getDiskRates(),
    ]);
    const items = (data && Array.isArray(data.list)) ? data.list : [];

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.pid == null) continue;
      try {
        const p = toProcess(item, logicalCores, currentUser);
        const nr = netRates.get(p.pid);
        if (nr) p.netBytesSec = nr;
        const dr = diskRates.get(p.pid);
        if (dr) {
          p.diskReadBytesSec = dr.readBytesSec;
          p.diskWriteBytesSec = dr.writeBytesSec;
        }
        out.push(p);
      } catch (_) {
        // Skip an individual malformed entry rather than failing the whole list.
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { list, classify };
