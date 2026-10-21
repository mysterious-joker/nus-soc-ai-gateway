const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGateway } = require("../server");
const { createCatalog } = require("../lib/catalog");
const { createStore } = require("../lib/store");
const { createBridge } = require("../lib/bridge");
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nus-gateway-test-"));
}
const fakeBridge = () => ({
  port: 8317,
  key: "test-bridge-key",
  status: { running: true },
  notices: [],
  accounts: () => [],
  flows: () => ({}),
  initialize: async () => {},
  start() {},
  stop() {},
});
test("dashboard authentication, CSRF, key scopes, malformed requests and secret redaction", async (t) => {
  const dataDir = temporary();
  const app = createGateway({ port: 0, dataDir, bridge: fakeBridge() });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let r = await fetch(base + "/api/dashboard");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  r = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(r.status, 400);
  r = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs.readFileSync(path.join(dataDir, "dashboard-token"), "utf8"),
    }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const { csrf } = await r.json();
  const auth = {
    Cookie: cookie,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  r = await fetch(base + "/api/keys", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: '{"name":"test"}',
  });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/providers/gemini/oauth", {
    method: "POST",
    headers: auth,
    body: '{"clientJson":"private-client"}',
  });
  assert.equal(r.status, 404, "Removed Gemini endpoint is unavailable");
  r = await fetch(base + "/api/providers/gemini/project", {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  assert.equal(r.status, 404, "Removed Gemini project route is unavailable");
  r = await fetch(base + "/api/dashboard", { headers: auth });
  const sourceDashboard = await r.json();
  assert.deepEqual(
    sourceDashboard.sources.map((s) => s.provider),
    ["chatgpt", "gemini", "soclaas"],
  );
  assert.equal(sourceDashboard.geminiOAuth, undefined);
  r = await fetch(base + "/api/keys", {
    method: "POST",
    headers: { ...auth, Origin: "https://evil.test" },
    body: '{"name":"test"}',
  });
  assert.equal(r.status, 403);
  for (const body of ["{", "null", "[]", '"hello"']) {
    r = await fetch(base + "/api/keys", {
      method: "POST",
      headers: auth,
      body,
    });
    assert.equal(r.status, 400);
  }
  r = await fetch(base + "/api/keys", {
    method: "POST",
    headers: auth,
    body: '{"name":"Notebook"}',
  });
  assert.equal(r.status, 201);
  const key = await r.json();
  const stored = app.store.db
    .prepare("SELECT api_key FROM api_keys WHERE id=?")
    .get(key.id);
  assert.match(stored.api_key, /^sha256:/);
  assert.notEqual(stored.api_key, key.token);
  r = await fetch(base + "/api/dashboard", {
    headers: { Authorization: `Bearer ${key.token}` },
  });
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/dashboard", { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const dashboard = await r.text();
  assert(!dashboard.includes(key.token));
  assert(!dashboard.includes("test-bridge-key"));
  assert(!dashboard.includes("sha256:"));
  r = await fetch(base + "/v1/models", {
    headers: { Authorization: `Bearer ${key.token}` },
  });
  assert.equal(r.status, 200);
  r = await fetch(base + "/v1/models?key=" + key.token);
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/keys?id=" + key.id, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(r.status, 200);
  r = await fetch(base + "/v1/models", {
    headers: { Authorization: `Bearer ${key.token}` },
  });
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/session", { method: "DELETE", headers: auth });
  assert.equal(r.status, 200);
  r = await fetch(base + "/api/dashboard", { headers: { Cookie: cookie } });
  assert.equal(r.status, 401);
  r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
});
test("catalog uses network results only, handles duplicates and coalesces refreshes", async () => {
  const dataDir = temporary();
  const store = createStore(dataDir);
  store.setSoclaasKey("test-key");
  let calls = 0;
  const bridge = {
    accounts: () => [{ id: "one", provider: "chatgpt", email: "a@u.nus.edu" }],
    rawAccount: () => ({ access_token: "test" }),
  };
  const fetcher = async (url) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (url.includes("codex/models"))
      return Response.json({ models: [{ slug: "shared-model" }] });
    if (url.includes("/wham/usage")) return Response.json({});
    return Response.json({
      data: [
        { id: "shared-model", type: "llm" },
        { id: "vector-model", type: "embedding" },
      ],
    });
  };
  const catalog = createCatalog({ bridge, store, fetcher });
  await Promise.all([
    catalog.refresh(true),
    catalog.refresh(true),
    catalog.refresh(true),
  ]);
  assert.equal(calls, 3);
  assert.equal(catalog.list().length, 3);
  assert.equal(catalog.list().filter((m) => m.available).length, 0);
  catalog.observeResult(
    catalog.list().find((m) => m.id === "soclaas/shared-model"),
    "/v1/chat/completions",
    200,
    true,
  );
  assert.equal(
    (await catalog.resolve("soclaas/shared-model")).provider,
    "soclaas",
  );
  await assert.rejects(catalog.resolve("shared-model"), /multiple sources/);
  await assert.rejects(catalog.resolve("made-up-model"), /not returned/);
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test("failed OAuth admission is quarantined before the proxy can load it", async () => {
  const dataDir = temporary();
  fs.mkdirSync(path.join(dataDir, "auths"));
  fs.writeFileSync(
    path.join(dataDir, "auths", "bad.json"),
    JSON.stringify({
      type: "codex",
      email: "x@example.com",
      access_token: "secret",
    }),
  );
  const bridge = createBridge({
    dataDir,
    port: 8317,
    binary: "/missing",
    verify: async () => {
      throw new Error("rejected");
    },
  });
  await bridge.initialize();
  assert.equal(bridge.accounts().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "verified-auths")), []);
  assert.equal(fs.readdirSync(path.join(dataDir, "quarantine")).length, 1);
  bridge.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test("proxy distinguishes provider IDs and records Responses streaming usage", async (t) => {
  const dataDir = temporary();
  const store = createStore(dataDir);
  const key = store.createKey("test");
  let upstreamBody;
  const model = {
    id: "chatgpt/shared-model",
    upstreamId: "shared-model",
    provider: "chatgpt",
    type: "llm",
    available: true,
  };
  const catalog = {
    resolve: async () => model,
    refresh: async () => {},
    list: () => [model],
    sources: () => [],
  };
  const fetcher = async (url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const app = createGateway({
    port: 0,
    dataDir,
    store,
    bridge: fakeBridge(),
    catalog,
    fetcher,
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(
    `http://127.0.0.1:${app.server.address().port}/v1/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: model.id, input: "Hi", stream: true }),
    },
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(upstreamBody.model, "chatgpt/shared-model");
  assert.equal(store.analytics().totals.tokens, 10);
});
test(
  "OAuth stdin stays open while waiting for the browser callback",
  { skip: process.platform === "win32" && "POSIX executable fixture" },
  async () => {
    const dataDir = temporary();
    const executable = path.join(dataDir, "fake-oauth");
    fs.writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('-config')+1],'utf8'));
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
console.log('https://auth.openai.com/oauth/authorize?state=test');
setTimeout(()=>{fs.writeFileSync(path.join(config.oauth['auth-dir'],'account.json'),JSON.stringify({type:'codex',access_token:'synthetic'}));process.exit(0);},350);
`,
      { mode: 0o700 },
    );
    const bridge = createBridge({
      dataDir,
      port: 8317,
      binary: executable,
      verify: async () => ({
        email: "test@u.nus.edu",
        subject: "test",
        verifiedAt: new Date().toISOString(),
      }),
    });
    await bridge.startLogin("chatgpt", "browser");
    for (
      let i = 0;
      i < 30 && bridge.flows().chatgpt.status !== "completed";
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.flows().chatgpt.status, "completed");
    assert.equal(bridge.accounts().length, 1);
    bridge.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  },
);
test("a missing bridge executable is handled without crashing the gateway", async () => {
  const dataDir = temporary();
  const bridge = createBridge({
    dataDir,
    port: 8317,
    binary: path.join(dataDir, "does-not-exist"),
  });
  bridge.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.status.running, false);
  assert.match(bridge.status.error, /could not start/);
  bridge.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("removed Gemini credentials are cleared without affecting other sources", async () => {
  const dir = temporary();
  let store = createStore(dir);
  store.set("gemini_oauth_secret", "old-encrypted-secret");
  store.set("gemini_api_access", { message: "old" });
  store.setSoclaasKey("preserved-soclaas-key");
  store.db.close();
  store = createStore(dir);
  assert.equal(store.get("gemini_oauth_secret"), null);
  assert.equal(store.get("gemini_api_access"), null);
  assert.equal(store.soclaasKey(), "preserved-soclaas-key");
  const bridge = createBridge({ dataDir: dir, port: 8317, binary: "unused" });
  await assert.rejects(
    bridge.startLogin("gemini", "browser"),
    /Choose ChatGPT/,
  );
  bridge.stop();
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ChatGPT discovery keeps every server model and marks hidden entries without a fixed count", async () => {
  const { discover } = require("../lib/providers");
  const models = Array.from({ length: 15 }, (_, i) => ({
    slug: `server-model-${i}`,
    display_name: `Server model ${i}`,
    visibility: i === 7 ? "hide" : "list",
  }));
  const result = await discover(
    "chatgpt",
    { access_token: "test" },
    async (url) => {
      assert.match(
        url,
        /chatgpt\.com\/backend-api\/codex\/models\?client_version=/,
      );
      return Response.json({ models });
    },
  );
  assert.equal(result.models.length, 15);
  assert.equal(result.models[14].upstreamId, "server-model-14");
  assert.equal(result.models[7].providerHidden, true);
  assert.equal(result.models[0].providerHidden, false);
});
