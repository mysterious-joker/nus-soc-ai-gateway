const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const smokeDir = process.argv.includes("--smoke-test")
  ? fs.mkdtempSync(path.join(os.tmpdir(), "gateway-desktop-smoke-"))
  : null;
if (smokeDir) env.GATEWAY_SMOKE_DATA_DIR = smokeDir;
const child = spawn(
  require("electron"),
  [path.resolve(__dirname, ".."), ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
child.on("error", () => {
  console.error("Desktop runtime could not start. Run npm ci and try again.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  // Windows keeps Chromium profile files open until the application has exited.
  if (smokeDir)
    fs.rmSync(smokeDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  process.exitCode = code ?? 1;
});
