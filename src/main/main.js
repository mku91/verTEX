const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

// Development builds open a local debugging port (this machine only), so that
// the state of a running window can be inspected from outside.
const DEBUG_PORT = 9333;
if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'verTEX',
    backgroundColor: '#282a36', // the default theme's background, shown until the page paints
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

// Menu items talk to the renderer through a single 'menu' channel.
const send = (action) => (_item, win) => win?.webContents.send('menu', action);

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая сцена', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { type: 'separator' },
        { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: send('settings') },
        { type: 'separator' },
        { label: 'Выход', role: 'quit' },
      ],
    },
    {
      // Shortcuts are shown but handled in the renderer, so that text fields
      // keep their own Ctrl+Z.
      label: 'Правка',
      submenu: [
        { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: send('undo') },
        { label: 'Повторить', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: send('redo') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Три вида', accelerator: 'V', registerAccelerator: false, click: send('toggle-views') },
        { label: 'Показать выделение', accelerator: 'F', registerAccelerator: false, click: send('frame') },
        { type: 'separator' },
        { label: 'Перезагрузить', role: 'reload' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
        { label: 'Полный экран', role: 'togglefullscreen' },
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
