const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVerification, probeBody } = require("../lib/verification");
const { endpoints } = require("../lib/capabilities");
const { createGateway } = require("../server");

function model(id, type = "llm", provider = "soclaas") {
  const value = { id: `${provider}/${id}`, provider, type, routable: true };
  value.supportedEndpoints = endpoints(value);
  return value;
}
async function finish(verifier) {
  for (let i = 0; i < 200 && verifier.running(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(verifier.running(), false);
  return verifier.snapshot();
}

test("full verification covers every supported route once, shares speech evidence and skips unsupported models", async () => {
  const models = [
    model("text"),
    model("vector", "embedding"),
    model("image", "image-generation"),
    model("voice", "realtime-audio", "chatgpt"),
    model("transcribe", "speech-to-text"),
    { ...model("video", "video-generation"), routable: false },
  ];
  const verifier = createVerification();
  const calls = [];
  let active = 0;
  verifier.start(models, async (m, endpoint) => {
    assert.equal(++active, 1, "No concurrent inference");
    calls.push([m.id, endpoint]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { status: "passed", httpStatus: 200 };
  });
  assert.throws(() => verifier.start(models, () => {}), { status: 409 });
  const result = await finish(verifier);
  assert.equal(calls.length, 7);
  assert.equal(new Set(calls.map(JSON.stringify)).size, 7);
  assert.equal(
    result.results.filter((item) => item.status === "passed").length,
    8,
  );
  assert.equal(
    result.results.filter((item) => item.status === "skipped").length,
    1,
  );
  assert.match(
    result.results.find((item) => item.endpoint === "/v1/realtime").message,
    /speech check/,
  );
  assert.equal(result.status, "completed");
  result.results[0].status = "tampered";
  assert.equal(verifier.snapshot().results[0].status, "passed");
});

test("minimal payloads respect connector limits and include portable media fixtures", async () => {
  const chat = model("text");
  const body = probeBody(chat, "/v1/chat/completions");
  assert.deepEqual(body.messages, [{ role: "user", content: "Reply OK." }]);
  assert.equal(body.max_tokens, 32);
  assert.equal(probeBody(chat, "/v1/responses").max_output_tokens, 32);
  const codex = {
    ...model("text", "llm", "chatgpt"),
    reasoningLevels: ["high", "low", "medium"],
  };
  assert.equal(
    probeBody(codex, "/v1/chat/completions").reasoning_effort,
    "low",
  );
  assert.deepEqual(probeBody(codex, "/v1/responses").reasoning, {
    effort: "low",
  });
  assert.equal(probeBody(codex, "/v1/responses").max_output_tokens, undefined);
  assert.deepEqual(probeBody(model("high", "llm", "gemini"), "/v1/responses"), {
    model: "gemini/high",
    input: "Reply OK.",
  });
  assert.equal(
    probeBody(model("vector", "embedding"), "/v1/embeddings").input,
    "OK",
  );
  const audio = probeBody(
    model("audio", "speech-to-text"),
    "/v1/audio/transcriptions",
  );
  assert(audio instanceof FormData);
  const wav = Buffer.from(await audio.get("file").arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert(wav.length < 40_000, "Short mono speech fixture");
  const image = probeBody(
    model("image", "image-generation"),
    "/v1/images/edits",
  );
  assert.equal(image.get("n"), "1");
  assert.equal(image.get("quality"), "low");
  assert.equal(image.get("image").type, "image/png");
  assert(image.get("image").size < 1024);
});

test("quota, authentication and service errors pause only their source; failures never retry or pass", async () => {
  for (const status of [401, 402, 429, 503]) {
    const verifier = createVerification();
    const calls = [];
    verifier.start(
      [model("limited"), model("other", "llm", "gemini")],
      async (m) => {
        calls.push(m.id);
        return {
          status: m.provider === "soclaas" ? "failed" : "passed",
          httpStatus: m.provider === "soclaas" ? status : 200,
        };
      },
    );
    const result = await finish(verifier);
    assert.deepEqual(calls, [
      "soclaas/limited",
      "gemini/other",
      "gemini/other",
    ]);
    assert.equal(result.results[1].status, "skipped");
    assert.equal(result.results[0].status, "failed");
  }
  const verifier = createVerification();
  verifier.start([model("voice", "realtime-audio", "chatgpt")], async () => {
    throw new Error("private upstream detail");
  });
  const result = await finish(verifier);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[1].status, "skipped");
  assert(!JSON.stringify(result).includes("private upstream detail"));
});

test("cancellation aborts the active check, sends no remaining requests, and permits a new batch", async () => {
  const verifier = createVerification();
  let calls = 0;
  verifier.start([model("text")], async (m, endpoint, signal) => {
    calls++;
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  });
  const result = await verifier.cancel();
  assert.equal(calls, 1);
  assert.equal(result.status, "cancelled");
  assert(result.results.every((item) => item.status === "cancelled"));
  verifier.start([model("vector", "embedding")], async () => ({
    status: "passed",
    httpStatus: 200,
  }));
  assert.equal((await finish(verifier)).status, "completed");
  assert.throws(() => verifier.start([], () => {}), { status: 400 });
});

test("authenticated one-click checks traverse the real gateway, record usage and enable only successful endpoints", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nus-batch-test-"));
  const calls = [];
  const bridge = {
    port: 8317,
    key: "private-test-key",
    status: { running: true },
    notices: [],
    accounts: () => [],
    flows: () => ({}),
    initialize: async () => {},
    start() {},
    stop() {},
  };
  const app = createGateway({
    port: 0,
    dataDir,
    bridge,
    fetcher: async (url, options) => {
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            { id: "text", type: "llm" },
            { id: "vector", type: "embedding" },
            { id: "picture", type: "image-generation" },
            { id: "whisper", type: "speech-to-text" },
          ],
        });
      calls.push({ url, body: options.body });
      const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
      if (url.endsWith("/chat/completions"))
        return Response.json({
          choices: [{ message: { content: "OK" } }],
          usage,
        });
      if (url.endsWith("/responses"))
        return Response.json(
          { error: { message: "Unavailable" } },
          { status: 404 },
        );
      if (url.endsWith("/embeddings"))
        return Response.json({ data: [{ embedding: [0.1] }], usage });
      if (url.endsWith("/audio/transcriptions")) {
        assert(options.body instanceof FormData);
        assert.equal(options.body.get("file").type, "audio/wav");
        return Response.json({ text: "OK", usage });
      }
      if (url.endsWith("/images/edits"))
        assert(options.body instanceof FormData);
      return Response.json({ data: [{ b64_json: "synthetic-image" }], usage });
    },
  });
  app.store.setSoclaasKey("private-soc-test-key");
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await app.catalog.refresh(true);
  assert.equal(calls.length, 0, "Startup never starts inference");
  const key = app.store.createKey("test");
  assert.equal(
    (
      await fetch(`${base}/api/verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.token}` },
      })
    ).status,
    401,
  );
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs.readFileSync(path.join(dataDir, "dashboard-token"), "utf8"),
    }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();
  assert.equal(
    (
      await fetch(`${base}/api/verification`, {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
    403,
  );
  const auth = { Cookie: cookie, "X-CSRF-Token": csrf };
  assert.equal(
    (
      await fetch(`${base}/api/verification`, {
        method: "POST",
        headers: { ...auth, Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/api/verification`, { method: "POST", headers: auth }))
      .status,
    202,
  );
  let dashboard;
  for (let i = 0; i < 200; i++) {
    dashboard = await (
      await fetch(`${base}/api/dashboard`, { headers: auth })
    ).json();
    if (dashboard.verification.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(dashboard.verification.status, "completed");
  assert.equal(calls.length, 6);
  assert.equal(
    dashboard.verification.results.filter((item) => item.status === "passed")
      .length,
    5,
  );
  assert.equal(
    dashboard.verification.results.filter((item) => item.status === "failed")
      .length,
    1,
  );
  const models = await (
    await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${key.token}` },
    })
  ).json();
  assert.equal(models.data.length, 4);
  assert.deepEqual(models.data.find((m) => m.id === "soclaas/text").endpoints, [
    "/v1/chat/completions",
  ]);
  assert.equal(
    app.store.db.prepare("SELECT COUNT(*) AS n FROM usage_logs").get().n,
    6,
  );
  assert.equal(dashboard.lifetime.totals.tokens, 20);
  for (const secret of [
    cookie,
    csrf,
    "private-soc-test-key",
    "private-test-key",
  ])
    assert(!JSON.stringify(dashboard.verification).includes(secret));
});

test("locking the dashboard cancels active upstream work and prevents further checks", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nus-cancel-test-"));
  let calls = 0;
  let aborted = false;
  const bridge = {
    port: 8317,
    key: "test",
    status: {},
    notices: [],
    accounts: () => [],
    flows: () => ({}),
    initialize: async () => {},
    start() {},
    stop() {},
  };
  const app = createGateway({
    port: 0,
    dataDir,
    bridge,
    fetcher: async (url, options) => {
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "text", type: "llm" }] });
      calls++;
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    },
  });
  app.store.setSoclaasKey("test");
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs.readFileSync(path.join(dataDir, "dashboard-token"), "utf8"),
    }),
  });
  const auth = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": (await login.json()).csrf,
  };
  assert.equal(
    (await fetch(`${base}/api/verification`, { method: "POST", headers: auth }))
      .status,
    202,
  );
  for (let i = 0; i < 100 && !calls; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(
    (await fetch(`${base}/api/verification`, { method: "POST", headers: auth }))
      .status,
    409,
  );
  assert.equal(
    (
      await fetch(`${base}/api/providers/soclaas`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
    409,
  );
  assert.equal(
    (await fetch(`${base}/api/session`, { method: "DELETE", headers: auth }))
      .status,
    200,
  );
  for (let i = 0; i < 100 && !aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.equal(
    (await fetch(`${base}/api/dashboard`, { headers: auth })).status,
    401,
  );
});
