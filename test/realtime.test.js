const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { createGateway } = require("../server");
const { discoverRealtime } = require("../lib/realtime");

test("realtime discovery, verified-only admission, speech bytes, websocket auth and reported usage", async (t) => {
  const provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(provider, "listening");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-voice-"));
  provider.on("connection", (ws, req) => {
    assert.equal(req.headers.authorization, "Bearer bridge-only");
    ws.send(
      JSON.stringify({
        type: "session.created",
        session: {
          model: "discovered-voice",
          audio: { output: { format: { type: "audio/pcm", rate: 24000 } } },
        },
      }),
    );
    ws.on("message", (bytes) => {
      if (JSON.parse(bytes).type !== "response.create") return;
      ws.send(
        JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.alloc(480, 1).toString("base64"),
        }),
      );
      ws.send(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "r1",
            status: "completed",
            output: [{ type: "message" }],
            usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
          },
        }),
      );
    });
  });
  const bridge = {
    port: provider.address().port,
    key: "bridge-only",
    status: { running: true },
    notices: [],
    flows: () => ({}),
    accounts: () => [
      { id: "account", provider: "chatgpt", email: "student@u.nus.edu" },
    ],
    rawAccount: () => ({ access_token: "test" }),
    initialize: async () => {},
    start() {},
    stop() {},
  };
  const app = createGateway({
    port: 0,
    dataDir,
    bridge,
    discoverRealtime: () => discoverRealtime(bridge),
    fetcher: async (url) =>
      Response.json(
        url.includes("wham")
          ? {
              rate_limit: {
                primary_window: {
                  used_percent: 1,
                  limit_window_seconds: 18000,
                },
              },
            }
          : url.includes("codex/models")
            ? { models: [] }
            : { data: [] },
      ),
  });
  await app.start();
  await app.catalog.refresh(true);
  t.after(async () => {
    await app.stop();
    for (const ws of provider.clients) ws.terminate();
    await new Promise((r) => provider.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const key = app.store.createKey("consumer");
  const auth = {
    Authorization: `Bearer ${key.token}`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({
    model: "chatgpt/discovered-voice",
    input: "OK",
  });
  let res = await fetch(base + "/v1/models", { headers: auth });
  assert.equal(
    (await res.json()).data.length,
    0,
    "New discovery must not publish an untested model",
  );
  res = await fetch(base + "/v1/audio/speech", {
    method: "POST",
    headers: auth,
    body,
  });
  assert.equal(res.status, 403);
  res = await fetch(base + "/api/verify?endpoint=/v1/audio/speech", {
    method: "POST",
    headers: auth,
    body,
  });
  assert.equal(
    res.status,
    401,
    "An inference key cannot verify or admit models",
  );
  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs
        .readFileSync(path.join(dataDir, "dashboard-token"), "utf8")
        .trim(),
    }),
  });
  const admin = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": (await login.json()).csrf,
    "Content-Type": "application/json",
  };
  res = await fetch(base + "/api/verify?endpoint=/v1/audio/speech", {
    method: "POST",
    headers: { Cookie: admin.Cookie, "Content-Type": "application/json" },
    body,
  });
  assert.equal(res.status, 403);
  res = await fetch(base + "/api/verify?endpoint=/v1/audio/speech", {
    method: "POST",
    headers: admin,
    body,
  });
  assert.equal(res.status, 200);
  const audio = Buffer.from(await res.arrayBuffer());
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.length, 524);
  res = await fetch(base + "/v1/models", { headers: auth });
  assert.deepEqual((await res.json()).data[0].endpoints, [
    "/v1/audio/speech",
    "/v1/realtime",
  ]);
  const target =
    base.replace("http:", "ws:") +
    "/v1/realtime?model=chatgpt/discovered-voice";
  const rejected = new WebSocket(target);
  const denial = await new Promise((resolve) => {
    rejected.on("unexpected-response", (_req, r) => {
      r.resume();
      rejected.terminate();
      resolve(r.statusCode);
    });
    rejected.on("error", () => {});
  });
  assert.equal(denial, 401);
  const ws = new WebSocket(target, { headers: auth });
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (bytes) => {
      const e = JSON.parse(bytes);
      if (e.type === "session.created")
        ws.send(JSON.stringify({ type: "response.create" }));
      if (e.type === "response.done") resolve();
    });
  });
  ws.close();
  await once(ws, "close");
  assert.equal(app.store.analytics().totals.tokens, 24);
  assert.equal(app.store.analytics().totals.requests, 2);
  app.catalog.observeResult(
    app.catalog.list()[0],
    "/v1/audio/speech",
    403,
    false,
  );
  res = await fetch(base + "/v1/audio/speech", {
    method: "POST",
    headers: auth,
    body,
  });
  assert.equal(
    res.status,
    403,
    "A failed endpoint must be blocked even when another endpoint passed",
  );
});
