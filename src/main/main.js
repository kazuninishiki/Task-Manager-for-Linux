// App lifecycle: create the window, load the UI, register IPC handlers.
// Linux edition — uses frameless window with custom renderer controls.

'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, nativeImage } = require('electron');

app.setName('Task Manager');

const IS_DEV = process.argv.includes('--dev');

// Application menu — minimal, standard shortcuts.
function buildMenu() {
  const template = [
    {
      label: 'Task Manager',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(IS_DEV ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#202020',
    show: false,
    // Linux: frameless window with custom renderer controls
    // (no native traffic lights like macOS)
    frame: false,
    title: 'Task Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (win === mainWindow) mainWindow = null;
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((err) => {
    console.error('[main] Failed to load renderer:', err);
  });

  if (IS_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// Register IPC handlers.
function registerIpc(win) {
  try {
    const ipc = require('./ipc');
    if (ipc && typeof ipc.register === 'function') {
      ipc.register(win);
    } else {
      console.error('[main] ./ipc does not export a register() function.');
    }
  } catch (err) {
    console.error('[main] Failed to register IPC handlers:', err);
  }
}

app.whenReady().then(() => {
  // Set the taskbar/dock icon
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    if (!icon.isEmpty()) {
      // On Linux, set the window icon (shows in taskbar)
      // This is handled via the BrowserWindow options below
    }
  } catch (_) { /* non-fatal */ }

  buildMenu();
  mainWindow = createWindow();
  registerIpc(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      registerIpc(mainWindow);
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}).catch((err) => {
  console.error('[main] App failed to initialize:', err);
});

// Utility app: quit when all windows are closed.
app.on('window-all-closed', () => {
  app.quit();
});
