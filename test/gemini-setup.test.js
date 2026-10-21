const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createGeminiSetup, loginScript } = require("../lib/gemini-setup");
const { installGeminiTool, toolDirectory } = require("../lib/gemini-tool");
const { createTools, resolveTool } = require("../lib/tools");
const { HttpError } = require("../lib/security");
const { createGateway } = require("../server");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-setup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("Setup did not reach the expected state");
}
const authLine =
  "applyAuthResult: email=test@comp.nus.edu.sg, authMethod=gcp, quotaProject=school\n";
function fixture(t, overrides = {}) {
  const dataDir = temporary(t);
  let connections = 0,
    refreshes = 0,
    login;
  const tools = {
    status: () => ({ gemini: { supported: true } }),
    installGemini: async () => {},
  };
  const gemini = {
    async connect({ signal }) {
      signal.throwIfAborted();
      if (++connections === 1) throw new HttpError(401, "Sign in first");
    },
    prepareLogin(directory) {
      login = {
        cwd: directory,
        executable: "/fake/agy",
        env: {},
        args: [],
        logFile: path.join(directory, "login.log"),
      };
      fs.writeFileSync(login.logFile, "", { mode: 0o600 });
      return login;
    },
  };
  const setup = createGeminiSetup({
    dataDir,
    tools,
    gemini,
    onConnected: async () => {
      refreshes++;
    },
    pollMs: 5,
    launch: async () => {
      fs.writeFileSync(login.logFile, authLine);
    },
    ...overrides,
  });
  t.after(() => setup.cancel());
  return {
    setup,
    dataDir,
    tools,
    gemini,
    connections: () => connections,
    refreshes: () => refreshes,
    login: () => login,
  };
}

test("Gemini setup reuses a saved session without opening a terminal or sending inference", async (t) => {
  let checked = false;
  const f = fixture(t, {
    gemini: {
      connect: async () => {
        checked = true;
      },
    },
    launch: async () => assert.fail("Saved login must not open a terminal"),
  });
  assert.equal(f.setup.start().status, "preparing");
  await until(() => !f.setup.running());
  assert.equal(checked, true);
  assert.equal(f.setup.snapshot().status, "connected");
  assert.equal(f.refreshes(), 1);
});

test("Guided Gemini sign-in validates the resulting CLI session and removes private artifacts", async (t) => {
  const f = fixture(t);
  f.setup.start();
  assert.throws(() => f.setup.start(), /already running/);
  await until(() => !f.setup.running());
  assert.equal(f.setup.snapshot().status, "connected");
  assert.equal(f.connections(), 2);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  assert.equal(JSON.stringify(f.setup.snapshot()).includes("test@"), false);
});

test("Gemini setup rejects wrong accounts and never connects on timeout or cancellation", async (t) => {
  const wrong = fixture(t, {
    launch: async () => {
      fs.writeFileSync(
        wrong.login().logFile,
        authLine.replace("comp.nus.edu.sg", "gmail.com"),
      );
    },
  });
  wrong.setup.start();
  await until(() => !wrong.setup.running());
  assert.equal(wrong.setup.snapshot().status, "error");
  assert.match(wrong.setup.snapshot().message, /different account/);
  assert.equal(wrong.connections(), 1);
  assert.equal(wrong.refreshes(), 0);

  const expired = fixture(t, { launch: async () => {}, timeoutMs: 10 });
  expired.setup.start();
  await until(() => !expired.setup.running());
  assert.match(expired.setup.snapshot().message, /timed out/);
  assert.equal(expired.connections(), 1);

  const cancelled = fixture(t, { launch: async () => {} });
  cancelled.setup.start();
  await until(() => cancelled.setup.snapshot().status === "waiting");
  await cancelled.setup.cancel();
  assert.equal(cancelled.setup.snapshot().status, "cancelled");
  assert.equal(cancelled.connections(), 1);
  assert.equal(cancelled.refreshes(), 0);
  assert.deepEqual(fs.readdirSync(cancelled.dataDir), []);
});

test("Cancelling while Gemini is checking credentials prevents late catalog activation", async (t) => {
  let release;
  const f = fixture(t, {
    gemini: {
      connect: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  f.setup.start();
  await until(() => !!release);
  const cancelled = f.setup.cancel();
  release();
  await cancelled;
  assert.equal(f.setup.snapshot().status, "cancelled");
  assert.equal(f.refreshes(), 0);
});

test("Gemini setup reports unsupported systems and sanitized launch failures", async (t) => {
  const unsupported = fixture(t, {
    tools: { status: () => ({ gemini: { supported: false } }) },
  });
  assert.throws(() => unsupported.setup.start(), /macOS and Linux/);
  const failed = fixture(t, {
    launch: async () => {
      throw new Error("secret-token");
    },
  });
  failed.setup.start();
  await until(() => !failed.setup.running());
  assert.equal(failed.setup.snapshot().status, "error");
  assert.equal(
    JSON.stringify(failed.setup.snapshot()).includes("secret-token"),
    false,
  );
  assert.deepEqual(fs.readdirSync(failed.dataDir), []);
});

test("Gemini installer rejects corrupt downloads and respects explicit executable overrides", async (t) => {
  const dataDir = temporary(t);
  await assert.rejects(
    installGeminiTool({
      dataDir,
      platform: "linux",
      arch: "x64",
      fetcher: async () => new Response("corrupt archive"),
    }),
    /checksum/,
  );
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "tools")), []);
  const tools = createTools({
    dataDir,
    env: { AGY_BIN: path.join(dataDir, "missing") },
    fetcher: () => assert.fail("Must not download past an override"),
  });
  await assert.rejects(tools.installGemini(), /AGY_BIN/);
  const managed = toolDirectory(dataDir, "linux", "x64");
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, "agy"), "fixture", { mode: 0o700 });
  assert.equal(
    resolveTool("agy", { dataDir, platform: "linux", arch: "x64", env: {} })
      .source,
    "managed",
  );
  const reuse = createTools({
    dataDir,
    platform: "linux",
    arch: "x64",
    env: {},
    fetcher: () => assert.fail("Must reuse an installed tool"),
  });
  await reuse.installGemini();
});

test(
  "Login launcher safely quotes paths and values and clears inherited authentication variables",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = temporary(t);
    const cwd = path.join(dir, "school's folder $(touch INJECTED)");
    fs.mkdirSync(cwd);
    const executable = path.join(cwd, "fake ' cli");
    fs.writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'%s\\n\' "$1" "$SAFE" "${GEMINI_API_KEY-unset}" > result\n',
      { mode: 0o700 },
    );
    const argument = "' $(touch INJECTED) `touch ALSO_INJECTED`";
    const done = path.join(cwd, "done ' marker");
    const script = path.join(dir, "launch.command");
    fs.writeFileSync(
      script,
      loginScript(
        { cwd, executable, env: { SAFE: argument }, args: [argument] },
        done,
      ),
    );
    execFileSync("/bin/sh", [script], {
      env: { ...process.env, GEMINI_API_KEY: "do-not-inherit" },
    });
    assert.equal(
      fs.readFileSync(path.join(cwd, "result"), "utf8"),
      `${argument}\n${argument}\nunset\n`,
    );
    assert.equal(fs.existsSync(done), true);
    assert.equal(fs.existsSync(path.join(cwd, "INJECTED")), false);
    assert.equal(fs.existsSync(path.join(cwd, "ALSO_INJECTED")), false);
  },
);

test("Gemini setup HTTP routes require dashboard CSRF and prevent overlapping full verification", async (t) => {
  const dataDir = temporary(t);
  let installs = 0;
  const app = createGateway({
    port: 0,
    dataDir,
    tools: {
      status: () => ({ gemini: { supported: true } }),
      installGemini: async ({ signal }) => {
        installs++;
        await delay(30_000, undefined, { signal });
      },
    },
    gemini: { stop() {} },
    bridge: {
      initialize: async () => {},
      start() {},
      stop() {},
      flows: () => ({}),
      accounts: () => [],
    },
    catalog: { refresh: async () => {}, list: () => [], sources: () => [] },
  });
  await app.start();
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const endpoint = base + "/api/providers/gemini/setup";
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs
        .readFileSync(path.join(dataDir, "dashboard-token"), "utf8")
        .trim(),
    }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers: { Cookie: cookie } }))
      .status,
    403,
  );
  assert.equal(installs, 0);
  const headers = { Cookie: cookie, "X-CSRF-Token": csrf };
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers })).status,
    202,
  );
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers })).status,
    409,
  );
  assert.equal(
    (await fetch(base + "/api/verification", { method: "POST", headers }))
      .status,
    409,
  );
  assert.equal(
    (await fetch(endpoint, { method: "DELETE", headers })).status,
    200,
  );
  assert.equal(installs, 1);
});
