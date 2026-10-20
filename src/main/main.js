const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { registerProjectIo } = require('./project-io.js');
const { registerAtlasFile } = require('./atlas-file.js');
const { registerRecent } = require('./recent.js');
const { registerExportIo } = require('./export-io.js');
const { registerLocale } = require('./locale.js');

// Development builds open a local debugging port (this machine only), so that
// the state of a running window can be inspected from outside.
// A second copy, started to try something out beside the one being worked in,
// is given a port of its own (VERTEX_DEBUG_PORT): the two must not be mistaken.
const DEBUG_PORT = Number(process.env.VERTEX_DEBUG_PORT) || 19333; // (not 9333: other programs on this machine take that one)
if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'verTEX',
    // Windows takes its icon sizes from the .ico (the taskbar, the title bar, Alt+Tab).
    icon: path.join(__dirname, '../../assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#282a36', // the default theme's background, shown until the page paints
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // The window starts on the welcome screen (see welcome.js): at the size
  // above, in the middle of the screen, with no menu bar (its keys work all
  // the same). The editor gets both - see 'window:editor' below.
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  // The page opens one window of its own: its views (see views-window.js).
  // Nothing else.
  win.webContents.setWindowOpenHandler(({ url }) => (url.endsWith('/views.html')
    ? {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1280,
        height: 860,
        title: t('window.views.title'),
        autoHideMenuBar: true,
        backgroundColor: '#282a36',
        icon: path.join(__dirname, '../../assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      },
    }
    : { action: 'deny' }));
  guardWindow(win); // unsaved changes are asked about before it closes
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

// A project opened or made: the editor, maximized - the views want all the
// room there is - and with the menu bar. Back on the welcome screen, the
// menu bar goes; the window stays as it is.
ipcMain.on('window:editor', (event, editing) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setMenuBarVisibility(Boolean(editing));
  if (editing && !win.isMaximized() && !win.isFullScreen()) win.maximize();
});

const t = registerLocale({ ipcMain, file: path.join(app.getPath('userData'), 'locale.json') });
const recent = registerRecent({ ipcMain, file: path.join(app.getPath('userData'), 'recent.json') });
const guardWindow = registerProjectIo({ ipcMain, dialog, BrowserWindow, recent, t });
registerAtlasFile({ ipcMain, shell, dialog, BrowserWindow, t });
registerExportIo({ ipcMain, dialog, BrowserWindow, t });

// Menu items talk to the renderer through a single 'menu' channel.
const send = (action) => (_item, win) => win?.webContents.send('menu', action);

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: t('menu.file'),
      submenu: [
        // The shortcuts are shown here but handled in the renderer, where the
        // user can rebind them (Settings -> Hotkeys).
        { label: t('menu.file.new'), accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: send('project-new') },
        { label: t('menu.file.open'), accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: send('project-open') },
        { type: 'separator' },
        { label: t('menu.file.save'), accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: send('project-save') },
        { label: t('menu.file.save-as'), accelerator: 'CmdOrCtrl+Shift+S', registerAccelerator: false, click: send('project-save-as') },
        { label: t('menu.file.close'), accelerator: 'CmdOrCtrl+Shift+Q', registerAccelerator: false, click: send('project-close-file') },
        { type: 'separator' },
        { label: t('menu.file.export-gltf'), click: send('export-gltf') },
        { label: t('menu.file.render-sprites'), click: send('render-sprites') },
        { type: 'separator' },
        { label: t('menu.file.settings'), accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: send('settings') },
        { type: 'separator' },
        // (Its own key: the one the role may bring, Ctrl+Q, is the cut tool's.)
        { label: t('menu.file.quit'), role: 'quit', accelerator: 'Alt+F4' },
      ],
    },
    {
      // Shortcuts are shown but handled in the renderer, so that text fields
      // keep their own Ctrl+Z.
      label: t('menu.edit'),
      submenu: [
        { label: t('menu.edit.undo'), accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: send('undo') },
        { label: t('menu.edit.redo'), accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: send('redo') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.view.views'), accelerator: 'B', registerAccelerator: false, click: send('toggle-views') },
        { label: t('menu.view.frame'), accelerator: 'F', registerAccelerator: false, click: send('frame') },
        { type: 'separator' },
        { label: t('menu.view.reload'), role: 'reload' },
        { label: t('menu.view.devtools'), role: 'toggleDevTools' },
        { label: t('menu.view.fullscreen'), role: 'togglefullscreen' },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
