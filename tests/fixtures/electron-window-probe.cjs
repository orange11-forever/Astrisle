const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { resolve } = require('node:path');
const electron = require('electron');
const project = resolve(__dirname, '../..');
const main = require.resolve(resolve(project, 'dist/desktop/main.cjs'));
const mode = process.env.ASTRISLE_WINDOW_PROBE;
const testTitle = 'Astrisle · 生命周期自动化测试';

const state = {
  windows: [],
  tray: undefined,
  balloons: 0,
  singleInstanceLocks: 0,
};
globalThis.astrisleWindowProbe = state;

const windowProbe = new Proxy(electron.BrowserWindow, {
  construct(NativeWindow, [options]) {
    // If the production entry requests a visible window, record the regression
    // and keep it off the desktop before the native constructor ever runs.
    const guard = options.show !== false;
    const win = new NativeWindow(guard ? { ...options, show: false, title: testTitle } : options);
    const record = {
      requestedVisible: guard,
      nativeVisibleAtCreation: win.isVisible(),
      requestedTitle: options.title,
      requestedFocusable: options.focusable !== false,
      showed: 0,
      focused: 0,
      hid: 0,
    };
    state.windows.push(record);
    if (guard) {
      win.accessibleTitle = testTitle;
      win.on('page-title-updated', (event) => event.preventDefault());
    }
    const hide = win.hide.bind(win);
    win.show = () => {
      record.showed++;
    };
    win.showInactive = () => {
      record.showed++;
    };
    win.focus = () => {
      record.focused++;
    };
    win.hide = () => {
      record.hid++;
      hide();
    };
    return win;
  },
});

class TrayProbe extends EventEmitter {
  constructor() {
    super();
    state.tray = this;
  }
  setToolTip(title) {
    this.title = title;
  }
  setContextMenu(menu) {
    this.menu = menu;
  }
  displayBalloon() {
    state.balloons++;
  }
  destroy() {
    this.removeAllListeners();
  }
}

electron.app.setAppPath(project);
electron.app.requestSingleInstanceLock = () => {
  state.singleInstanceLocks++;
  return true;
};
electron.dialog.showErrorBox = (_title, message) => {
  console.error(message);
};
electron.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
const probedElectron = Object.create(electron, {
  BrowserWindow: { value: windowProbe },
  Tray: { value: TrayProbe },
});
const load = Module._load;
const automation = process.env.ASTRISLE_AUTOMATION;
try {
  if (mode !== 'automation') delete process.env.ASTRISLE_AUTOMATION;
  if (mode === 'demo') process.env.ASTRISLE_MODEL_DEMO = '1';
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === main) return probedElectron;
    return load.call(this, request, parent, isMain);
  };
  require(main);
} finally {
  Module._load = load;
  if (automation !== undefined) process.env.ASTRISLE_AUTOMATION = automation;
}
