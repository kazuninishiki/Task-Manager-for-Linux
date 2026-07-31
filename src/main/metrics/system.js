// src/main/metrics/system.js
// Gathers cpu/mem/disk/net/gpu/os stats and maps them to the SystemStats wire
// shape. Every metric is fetched in parallel and is
// individually fault-tolerant: a failing probe yields null/sensible defaults.
//
// Linux notes: systeminformation handles CPU, disk stats, and network well.
// Memory comes from /proc/meminfo (more accurate than si on Linux), GPU
// utilization from nvidia-smi or sysfs, and threads from /proc/stat.

'use strict';

const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const MB = 1024 * 1024;

// Run a command and resolve its stdout, or null if it fails.
function execText(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// Accurate Linux memory via /proc/meminfo, providing the same rich shape
// as the macOS vm_stat path. Returns null on parse failure so caller falls
// back to si.mem().
async function getLinuxMemory() {
  if (process.platform !== 'linux') return null;
  try {
    const text = await new Promise((resolve) => {
      fs.readFile('/proc/meminfo', 'utf8', (err, data) => {
        resolve(err ? null : data);
      });
    });
    if (!text) return null;

    const val = (label) => {
      const m = text.match(new RegExp(label + ':\\s+(\\d+)'));
      return m ? parseInt(m[1], 10) * 1024 : 0; // /proc/meminfo is in KB
    };

    const totalBytes = val('MemTotal');
    const freeBytes = val('MemFree');
    const availableBytes = val('MemAvailable');
    const buffersBytes = val('Buffers');
    const cachedBytes = val('Cached');
    const slabReclaimable = val('SReclaimable');
    const swapTotalBytes = val('SwapTotal');
    const swapFreeBytes = val('SwapFree');

    // "Used" matches what htop/GNOME System Monitor show:
    // total - available (includes buffers/cache that can be freed)
    const usedBytes = availableBytes > 0
      ? Math.max(0, totalBytes - availableBytes)
      : Math.max(0, totalBytes - freeBytes - buffersBytes - cachedBytes);
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      freeBytes,
      cachedBytes: cachedBytes + buffersBytes + slabReclaimable,
      appBytes: null,       // not easily separable on Linux
      wiredBytes: null,     // concept doesn't exist on Linux
      compressedBytes: null, // zram compression not easily measurable
      swapUsedBytes,
      swapTotalBytes,
      percent,
    };
  } catch (_) {
    return null;
  }
}

function num(v, fallback = null) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function settled(result) {
  return result && result.status === 'fulfilled' ? result.value : null;
}

// Per-second rate from two cumulative samples; clamps negatives (counter resets).
function rate(cur, prev, dtSec) {
  if (prev == null || cur == null || !(dtSec > 0)) return 0;
  const r = (cur - prev) / dtSec;
  return r > 0 ? r : 0;
}

// GPU utilization on Linux.
// Tries nvidia-smi first, then AMD sysfs, then Intel sysfs.
async function getGpuUtil() {
  if (process.platform !== 'linux') return null;

  // NVIDIA: nvidia-smi
  const nvidiaOut = await execText('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (nvidiaOut) {
    const parts = nvidiaOut.trim().split(',').map((s) => parseFloat(s.trim()));
    if (parts.length >= 3 && !isNaN(parts[0])) {
      return {
        utilization: parts[0],
        memUsedBytes: !isNaN(parts[1]) ? parts[1] * MB : null,
        memTotalBytes: !isNaN(parts[2]) ? parts[2] * MB : null,
      };
    }
  }

  // AMD: /sys/class/drm/card*/device/gpu_busy_percent
  try {
    const drmDir = '/sys/class/drm';
    const cards = fs.readdirSync(drmDir).filter((d) => /^card\d+$/.test(d));
    for (const card of cards) {
      const busyPath = `${drmDir}/${card}/device/gpu_busy_percent`;
      if (fs.existsSync(busyPath)) {
        const busy = parseInt(fs.readFileSync(busyPath, 'utf8').trim(), 10);
        if (!isNaN(busy)) {
          return { utilization: busy, memUsedBytes: null, memTotalBytes: null };
        }
      }
    }
  } catch (_) { /* ignore */ }

  // Intel: /sys/class/drm/card*/engine/*/busy (aggregate)
  // This is more complex and less standardized; skip for now.

  return null;
}

// Thread count: count entries in /proc/*/task (accurate but fast on Linux).
// Cached with 5s TTL to avoid re-scanning on every poll.
let _threadCount = null;
let _threadStamp = 0;
function getThreadCount() {
  const now = Date.now();
  if (_threadCount !== null && (now - _threadStamp) < 5000) return _threadCount;
  _threadStamp = now;
  try {
    const procDir = '/proc';
    const pids = fs.readdirSync(procDir).filter((e) => /^\d+$/.test(e));
    let total = 0;
    for (const pid of pids) {
      try {
        const tasks = fs.readdirSync(`${procDir}/${pid}/task`);
        total += tasks.length;
      } catch (_) { /* permission denied */ }
    }
    _threadCount = total;
    return _threadCount;
  } catch (_) { /* ignore */ }
  return null;
}

// State carried between polls so we can compute throughput deltas ourselves.
let _prev = null; // { t, diskRead, diskWrite, netRx, netTx }

async function stats() {
  const results = await Promise.allSettled([
    si.currentLoad(),
    si.cpu(),
    si.cpuCurrentSpeed(),
    si.mem(),
    si.fsStats(),
    si.networkStats('*'),
    si.graphics(),
    si.osInfo(),
    si.time(),
    si.processes(),
    si.fsSize(),
    si.networkInterfaces(),
    si.networkInterfaceDefault(),
    getLinuxMemory(),
    getGpuUtil(),
  ]);

  const currentLoad = settled(results[0]) || {};
  const cpuInfo = settled(results[1]) || {};
  const cpuSpeed = settled(results[2]) || {};
  const mem = settled(results[3]) || {};
  const fsStats = settled(results[4]) || {};
  const networkStats = settled(results[5]) || [];
  const graphics = settled(results[6]) || {};
  const time = settled(results[8]) || {};
  const processes = settled(results[9]) || {};
  const fsSize = settled(results[10]) || [];
  const netIfaces = settled(results[11]) || [];
  const defaultIface = settled(results[12]) || '';
  const linuxMem = settled(results[13]);
  const gpuUtil = settled(results[14]);

  const threadCount = getThreadCount();

  // ---- Derive disk/net per-second rates from cumulative counters ----
  const now = Date.now();
  const dt = _prev ? (now - _prev.t) / 1000 : 0;

  const diskReadCum = num(fsStats.rx);
  const diskWriteCum = num(fsStats.wx);

  let netRxCum = 0;
  let netTxCum = 0;
  const ifaceArr = Array.isArray(networkStats) ? networkStats : [networkStats];
  for (const n of ifaceArr) {
    if (!n || /^lo/.test(n.iface || '')) continue;
    netRxCum += num(n.rx_bytes, 0);
    netTxCum += num(n.tx_bytes, 0);
  }

  const diskRead = rate(diskReadCum, _prev && _prev.diskRead, dt);
  const diskWrite = rate(diskWriteCum, _prev && _prev.diskWrite, dt);
  const netRx = rate(netRxCum, _prev && _prev.netRx, dt);
  const netTx = rate(netTxCum, _prev && _prev.netTx, dt);

  _prev = { t: now, diskRead: diskReadCum, diskWrite: diskWriteCum, netRx: netRxCum, netTx: netTxCum };

  return {
    cpu: buildCpu(currentLoad, cpuInfo, cpuSpeed, time),
    mem: linuxMem || buildMem(mem),
    disks: buildDisks(diskRead, diskWrite, fsSize),
    net: buildNet(netRx, netTx, netIfaces, defaultIface),
    gpu: buildGpu(graphics, gpuUtil),
    process: buildProcess(processes, threadCount),
  };
}

function buildCpu(currentLoad, cpuInfo, cpuSpeed, time) {
  try {
    const base = num(cpuInfo.speed);
    const cpus = Array.isArray(currentLoad.cpus) ? currentLoad.cpus : [];
    const perCore = cpus.map((c) => num(c && c.load, 0));
    let loadAvg = null;
    try { loadAvg = os.loadavg(); } catch (_) { loadAvg = null; }

    return {
      brand: typeof cpuInfo.brand === 'string' ? cpuInfo.brand : '',
      physicalCores: num(cpuInfo.physicalCores),
      logicalCores: num(cpuInfo.cores, perCore.length || null),
      perfCores: num(cpuInfo.performanceCores),
      effCores: num(cpuInfo.efficiencyCores),
      speedGHz: base,
      currentGHz: num(cpuSpeed.avg, base),
      load: num(currentLoad.currentLoad, 0),
      loadUser: num(currentLoad.currentLoadUser),
      loadSystem: num(currentLoad.currentLoadSystem),
      loadAvg: Array.isArray(loadAvg) ? loadAvg.map((x) => num(x, 0)) : null,
      perCore,
      uptimeSec: num(time.uptime, 0),
    };
  } catch (_e) {
    return {
      brand: '', physicalCores: null, logicalCores: null, perfCores: null,
      effCores: null, speedGHz: null, currentGHz: null, load: 0,
      loadUser: null, loadSystem: null, loadAvg: null, perCore: [], uptimeSec: 0,
    };
  }
}

function buildMem(mem) {
  try {
    const totalBytes = num(mem.total, 0);
    const available = num(mem.available);
    const freeBytes = num(mem.free, 0);
    const cachedBytes = num(mem.buffcache, num(mem.cached, 0));

    let usedBytes;
    if (available != null && totalBytes) {
      usedBytes = totalBytes - available;
    } else {
      usedBytes = num(mem.used, 0);
    }
    if (usedBytes < 0) usedBytes = 0;

    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    return {
      totalBytes,
      usedBytes,
      freeBytes,
      cachedBytes,
      swapUsedBytes: num(mem.swapused, 0),
      swapTotalBytes: num(mem.swaptotal, 0),
      percent,
    };
  } catch (_e) {
    return {
      totalBytes: 0, usedBytes: 0, freeBytes: 0, cachedBytes: 0,
      swapUsedBytes: 0, swapTotalBytes: 0, percent: 0,
    };
  }
}

function buildDisks(readBytesSec, writeBytesSec, fsSize) {
  try {
    const arr = Array.isArray(fsSize) ? fsSize : [];
    let root = arr.find((f) => f && f.mount === '/') || arr[0] || {};
    const sizeBytes = num(root.size);
    const usedBytes = num(root.used);
    const usePercent = num(root.use);

    return [
      {
        name: 'Disk 0',
        readBytesSec: num(readBytesSec, 0),
        writeBytesSec: num(writeBytesSec, 0),
        percent: null,
        sizeBytes,
        diskUsedBytes: usedBytes,
        usePercent,
        mount: typeof root.mount === 'string' ? root.mount : '/',
        fsType: typeof root.type === 'string' ? root.type : '',
      },
    ];
  } catch (_e) {
    return [{ name: 'Disk 0', readBytesSec: 0, writeBytesSec: 0, percent: null }];
  }
}

function buildNet(rxBytesSec, txBytesSec, netIfaces, defaultIface) {
  try {
    const ifaces = Array.isArray(netIfaces) ? netIfaces : [netIfaces];
    let primary = ifaces.find((i) => i && i.iface === defaultIface);
    if (!primary) {
      primary = ifaces.find((i) => i && i.ip4 && !i.internal && i.operstate === 'up');
    }
    if (!primary) primary = ifaces.find((i) => i && i.ip4 && !i.internal);
    const iface = (primary && primary.iface) || defaultIface || 'Network';
    const ip4 = (primary && primary.ip4) || '';

    return [
      {
        iface,
        ip4,
        rxBytesSec: num(rxBytesSec, 0),
        txBytesSec: num(txBytesSec, 0),
      },
    ];
  } catch (_e) {
    return [{ iface: 'Network', ip4: '', rxBytesSec: num(rxBytesSec, 0), txBytesSec: num(txBytesSec, 0) }];
  }
}

function buildGpu(graphics, gpuUtil) {
  try {
    const controllers = Array.isArray(graphics.controllers) ? graphics.controllers : [];
    const c = controllers[0] || {};
    const memUsed = num(c.memoryUsed);
    const memTotal = num(c.memoryTotal);
    const vram = num(c.vram);
    let cores = num(c.cores);
    if (cores == null && c.cores != null) cores = num(parseInt(c.cores, 10));

    const util = (gpuUtil && gpuUtil.utilization != null)
      ? gpuUtil.utilization
      : num(c.utilizationGpu);
    const usedBytes = memUsed != null ? memUsed * MB
      : (gpuUtil && gpuUtil.memUsedBytes != null ? gpuUtil.memUsedBytes : null);
    const totalBytes = memTotal != null ? memTotal * MB
      : (gpuUtil && gpuUtil.memTotalBytes != null ? gpuUtil.memTotalBytes
        : vram != null ? vram * MB : null);

    return {
      model: typeof c.model === 'string' ? c.model : '',
      cores,
      utilization: util,
      memUsedBytes: usedBytes,
      memTotalBytes: totalBytes,
      tempC: num(c.temperatureGpu),
    };
  } catch (_e) {
    return { model: '', cores: null, utilization: null, memUsedBytes: null, memTotalBytes: null, tempC: null };
  }
}

function buildProcess(processes, threadCount) {
  try {
    return { total: num(processes.all), threads: threadCount, handles: null };
  } catch (_e) {
    return { total: null, threads: threadCount, handles: null };
  }
}

module.exports = { stats };
