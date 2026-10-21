// Verify the actual DMG contents, not just the source Electron runtime.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { version } = require("../package.json");
if (process.platform !== "darwin") throw new Error("Run this check on macOS.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-installer-check-"));
const mount = path.join(root, "mounted");
fs.mkdirSync(mount);
const env = {
  ...process.env,
  GATEWAY_SMOKE_DATA_DIR: path.join(root, "profile"),
};
delete env.ELECTRON_RUN_AS_NODE;
const run = (file, args) =>
  execFileSync(file, args, { env, stdio: "inherit", timeout: 120_000 });
let mounted = false;
try {
  run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
    path.resolve(
      __dirname,
      "..",
      "dist",
      `nus-soc-ai-gateway-${version}-mac-${process.arch}.dmg`,
    ),
  ]);
  mounted = true;
  const app = path.join(mount, "NUS SoC AI Gateway.app");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  run(path.join(app, "Contents", "MacOS", "NUS SoC AI Gateway"), [
    "--smoke-test",
  ]);
  console.log(
    "Mac installer passed: DMG signature integrity and packaged dashboard startup.",
  );
} finally {
  if (mounted) run("hdiutil", ["detach", mount]);
  fs.rmSync(root, { recursive: true, force: true });
}
