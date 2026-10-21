const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createGateway } = require("../server");
const { externalUrlAllowed } = require("./policy");

process.umask(0o077);
app.setName("NUS SoC AI Gateway");
const smoke = process.argv.includes("--smoke-test");
if (smoke)
  app.setPath(
    "userData",
    process.env.GATEWAY_SMOKE_DATA_DIR ||
      fs.mkdtempSync(
        path.join(require("node:os").tmpdir(), "gateway-desktop-smoke-"),
      ),
  );
let gateway,
  window,
  origin,
  stopping = false,
  stopped = false;
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function dashboardUrl() {
  const token = fs
    .readFileSync(path.join(gateway.dataDir, "dashboard-token"), "utf8")
    .trim();
  return `${origin}/#token=${encodeURIComponent(token)}`;
}
function external(url) {
  if (externalUrlAllowed(url)) shell.openExternal(url).catch(() => {});
}
function createWindow() {
  window = new BrowserWindow({
    title: "NUS SoC AI Gateway",
    width: 1200,
    height: 850,
    minWidth: 760,
    minHeight: 560,
    show: !smoke,
    backgroundColor: "#10151e",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "gateway-dashboard",
    },
  });
  const session = window.webContents.session;
  session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(
      contents === window?.webContents &&
        new URL(contents.getURL()).origin === origin &&
        permission === "clipboard-sanitized-write",
    );
  });
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      contents === window?.webContents &&
      requestingOrigin === origin &&
      permission === "clipboard-sanitized-write",
  );
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      external(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("closed", () => {
    window = null;
    app.quit();
  });
  return window.loadURL(dashboardUrl());
}
async function start() {
  const dataDir = path.join(app.getPath("userData"), "gateway");
  const bridgePort = await freePort();
  gateway = createGateway({ dataDir, bridgePort, port: smoke ? 0 : 4000 });
  try {
    await gateway.start();
  } catch (error) {
    await gateway.stop();
    if (error.code !== "EADDRINUSE") throw error;
    gateway = createGateway({ dataDir, bridgePort, port: 0 });
    await gateway.start();
  }
  origin = `http://127.0.0.1:${gateway.server.address().port}`;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Gateway",
        submenu: [
          {
            label: "Open dashboard",
            click: () => {
              if (window) {
                window.loadURL(dashboardUrl());
                window.show();
              }
            },
          },
          {
            label: "API reference",
            click: () => window?.loadURL(`${origin}/reference`),
          },
          {
            label: "Show local data folder",
            click: () => shell.openPath(dataDir),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Help",
        submenu: [
          {
            label: "Setup guide",
            click: () =>
              external(
                "https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md",
              ),
          },
          {
            label: "Check for updates",
            click: () =>
              external(
                "https://github.com/mysterious-joker/nus-soc-ai-gateway/releases/latest",
              ),
          },
          {
            label: "Report a problem",
            click: () =>
              external(
                "https://github.com/mysterious-joker/nus-soc-ai-gateway/issues",
              ),
          },
        ],
      },
    ]),
  );
  await createWindow();
  if (smoke) {
    // Runs the real renderer, HTTP server, session exchange and SQLite store in isolation.
    const waitFor = async (expression) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await window.webContents.executeJavaScript(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Desktop session transition timed out.");
    };
    const ready =
      "!document.getElementById('workspace').hidden && document.querySelectorAll('.source').length === 3";
    await waitFor(ready);
    await waitFor(
      "[...document.querySelectorAll('button')].some(b => b.textContent === 'Connect Gemini')",
    );
    await window.webContents.executeJavaScript(
      "document.getElementById('lock').click()",
    );
    await waitFor("!document.getElementById('unlock').hidden");
    await window.loadURL(dashboardUrl());
    await waitFor(ready);
    await window.webContents.executeJavaScript(
      "document.getElementById('tab-models').click()",
    );
    await waitFor(
      "document.getElementById('verify-all')?.getBoundingClientRect().width > 0",
    );
    const isolated = await window.webContents.executeJavaScript(
      "typeof require === 'undefined' && typeof process === 'undefined' && location.hash === ''",
    );
    if (!isolated)
      throw new Error("Desktop isolation or token removal failed.");
    console.log(
      "Desktop smoke passed: SQLite, HTTP startup, automatic unlock, lock/reopen, three sources, Connect Gemini and Verify all models buttons, isolated renderer, removed token fragment.",
    );
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      if (smoke) {
        console.error(error.message);
        process.exitCode = 1;
      } else
        dialog.showErrorBox(
          "Gateway could not start",
          "Close other gateway instances and reopen the app. Check that your local data folder is writable. Your saved connections have been kept.",
        );
      app.quit();
    });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    Promise.resolve(gateway?.stop())
      .catch(() => {})
      .finally(() => {
        stopped = true;
        app.exit(process.exitCode || 0);
      });
  });
}
