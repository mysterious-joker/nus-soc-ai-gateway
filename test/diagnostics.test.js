const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createGateway } = require("../server");

test("catalog audit works on a fresh installation with disconnected sources and cleans up its key", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nus-audit-test-"));
  const bridge = {
    status: { running: true },
    notices: [],
    accounts: () => [],
    flows: () => ({}),
    initialize: async () => {},
    start() {},
    stop() {},
  };
  const app = createGateway({ port: 0, dataDir, bridge });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await promisify(execFile)(
    process.execPath,
    [path.resolve(__dirname, "../scripts/audit-catalogs.js")],
    {
      env: {
        ...process.env,
        PORT: String(app.server.address().port),
        GATEWAY_DATA_DIR: dataDir,
        GATEWAY_REPORT_DIR: dataDir,
      },
      timeout: 15_000,
    },
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(dataDir, "catalog-audit.json"), "utf8"),
  );
  assert.equal(report.sources.length, 3);
  assert(
    report.sources.every(
      (s) =>
        s.status === "disconnected" &&
        s.gatewayCount === 0 &&
        s.upstreamCount === 0,
    ),
  );
  assert.deepEqual(app.store.keys(), [], "temporary audit key must be revoked");
  assert(
    !JSON.stringify(report).includes(
      fs.readFileSync(path.join(dataDir, "dashboard-token"), "utf8").trim(),
    ),
  );
});
