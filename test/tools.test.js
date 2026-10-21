const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tar = require("tar");
const {
  createTools,
  resolveTool,
  verifyDigest,
  extractArchive,
} = require("../lib/tools");
const { browserCommand } = require("../lib/browser");
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("executable detection honors PATH and explicit overrides without silent fallback", (t) => {
  const dir = temporary(t);
  const bin = path.join(dir, "cliproxyapi");
  fs.writeFileSync(bin, "test", { mode: 0o700 });
  assert.equal(
    resolveTool("cliproxyapi", { env: { PATH: dir }, home: dir }).path,
    bin,
  );
  assert.equal(
    resolveTool("cliproxyapi", {
      env: { CPA_BIN: path.join(dir, "missing"), PATH: dir },
    }),
    null,
  );
  if (process.platform !== "win32") {
    fs.chmodSync(bin, 0o600);
    assert.notEqual(
      resolveTool("cliproxyapi", { env: { PATH: dir }, home: dir })?.path,
      bin,
    );
  }
});
test("corrupt tool downloads fail closed and leave no installed binary", async (t) => {
  const dataDir = temporary(t);
  const manager = createTools({
    dataDir,
    env: {},
    platform: "linux",
    arch: "x64",
    fetcher: async () => new Response("corrupt archive"),
  });
  assert.throws(
    () => verifyDigest(Buffer.from("bad"), "0".repeat(64)),
    /checksum/,
  );
  await assert.rejects(manager.installBridge(), /checksum/);
  assert.equal(manager.status().bridge.installing, false);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "tools")), []);
});
test("archive extraction accepts only the expected regular binary and license", async (t) => {
  const dir = temporary(t);
  const output = path.join(dir, "out");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(dir, "cli-proxy-api"), "binary");
  fs.writeFileSync(path.join(dir, "unexpected.js"), "malicious");
  const file = path.join(dir, "download.tar.gz");
  await tar.c({ gzip: true, file, cwd: dir }, [
    "cli-proxy-api",
    "unexpected.js",
  ]);
  await extractArchive(file, output, "cliproxyapi");
  assert.deepEqual(fs.readdirSync(output), ["cliproxyapi"]);
  assert.equal(
    fs.readFileSync(path.join(output, "cliproxyapi"), "utf8"),
    "binary",
  );
});
test(
  "archive symlinks cannot become executable tools",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = temporary(t);
    const output = path.join(dir, "out");
    fs.mkdirSync(output);
    fs.symlinkSync("/bin/sh", path.join(dir, "cli-proxy-api"));
    const file = path.join(dir, "download.tar.gz");
    await tar.c({ gzip: true, file, cwd: dir }, ["cli-proxy-api"]);
    await assert.rejects(
      extractArchive(file, output, "cliproxyapi"),
      /expected executable/,
    );
    assert.deepEqual(fs.readdirSync(output), []);
  },
);
test("browser launch uses argument arrays on each platform and rejects remote URLs", () => {
  const url = "http://localhost:4000/#token=example";
  assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(browserCommand(url, "win32"), [
    "rundll32.exe",
    ["url.dll,FileProtocolHandler", url],
  ]);
  assert.throws(() => browserCommand("https://evil.test"), /local gateway/);
});
