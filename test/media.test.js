const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGateway } = require("../server");
const { createStore } = require("../lib/store");
const { createCatalog } = require("../lib/catalog");
const { readResponse } = require("../lib/media");

test("media routes authenticate, validate multipart uploads, rewrite IDs and preserve outputs", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-media-"));
  const store = createStore(dataDir);
  store.setSoclaasKey("private-soc-key");
  const models = [
    {
      id: "soclaas/transcriber",
      upstreamId: "transcriber",
      provider: "soclaas",
      type: "speech-to-text",
      available: true,
    },
    {
      id: "chatgpt/image-model",
      upstreamId: "image-model",
      provider: "chatgpt",
      type: "image-generation",
      available: true,
    },
  ];
  const calls = [],
    results = [];
  const catalog = {
    refresh: async () => {},
    list: () => models,
    sources: () => [],
    resolve: async (id) => {
      const model = models.find((m) => m.id === id);
      if (!model)
        throw Object.assign(new Error("Unknown model"), { status: 404 });
      return model;
    },
    observeResult: (...r) => results.push(r),
  };
  const bridge = {
    port: 8317,
    key: "private-bridge-key",
    status: { running: true },
    initialize: async () => {},
    start() {},
    stop() {},
  };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/transcriptions")) {
      assert(options.body instanceof FormData);
      assert.equal(options.body.get("model"), "transcriber");
      assert.equal(options.headers.Authorization, "Bearer private-soc-key");
      assert.equal(options.headers["Content-Type"], undefined);
      assert.deepEqual(
        [...new Uint8Array(await options.body.get("file").arrayBuffer())],
        [82, 73, 70, 70],
      );
      if (options.body.get("response_format") === "text")
        return new Response("hello", {
          headers: { "Content-Type": "text/plain" },
        });
      return Response.json({
        text: "hello",
        usage: { type: "duration", seconds: 1 },
      });
    }
    assert.equal(options.headers.Authorization, "Bearer private-bridge-key");
    assert.equal(
      options.body instanceof FormData
        ? options.body.get("model")
        : JSON.parse(options.body).model,
      "chatgpt/image-model",
    );
    if (typeof options.body === "string" && JSON.parse(options.body).stream)
      return new Response(
        'data: {"type":"error","error":{"message":"generation failed"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return Response.json({
      data: [{ b64_json: "aW1hZ2U=" }],
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
    });
  };
  const app = createGateway({
    port: 0,
    dataDir,
    store,
    bridge,
    catalog,
    fetcher,
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const key = store.createKey("test");
  const auth = { Authorization: `Bearer ${key.token}` };
  const audio = () => {
    const f = new FormData();
    f.set("model", "soclaas/transcriber");
    f.set("file", new Blob([Buffer.from("RIFF")]), "sample.wav");
    return f;
  };
  let r = await fetch(base + "/v1/audio/transcriptions", {
    method: "POST",
    body: audio(),
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
  r = await fetch(base + "/v1/audio/transcriptions", {
    method: "POST",
    headers: auth,
    body: audio(),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, "hello");
  const textForm = audio();
  textForm.set("response_format", "text");
  r = await fetch(base + "/v1/audio/transcriptions", {
    method: "POST",
    headers: auth,
    body: textForm,
  });
  assert.equal(await r.text(), "hello");
  assert.match(r.headers.get("content-type"), /text\/plain/);
  const duplicate = audio();
  duplicate.append("model", "chatgpt/image-model");
  r = await fetch(base + "/v1/audio/transcriptions", {
    method: "POST",
    headers: auth,
    body: duplicate,
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 2);
  const wrongType = audio();
  wrongType.set("model", "chatgpt/image-model");
  r = await fetch(base + "/v1/audio/transcriptions", {
    method: "POST",
    headers: auth,
    body: wrongType,
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 2);
  r = await fetch(base + "/v1/images/generations", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/image-model", prompt: "circle" }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.length, 1);
  const edit = new FormData();
  edit.set("model", "chatgpt/image-model");
  edit.set("image", new Blob([Buffer.from("image")]), "image.png");
  edit.set("prompt", "edit");
  r = await fetch(base + "/v1/images/edits", {
    method: "POST",
    headers: auth,
    body: edit,
  });
  assert.equal(r.status, 200);
  assert.equal(results.length, 4);
  const analytics = store.analytics("all");
  assert.equal(analytics.totals.tokens, 24);
  assert.equal(
    analytics.totals.reported,
    2,
    "Duration-based audio usage must not be invented as tokens",
  );
  r = await fetch(base + "/v1/images/edits", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "multipart/form-data; boundary=broken",
    },
    body: "bad",
  });
  assert.equal(r.status, 400);
  r = await fetch(base + "/v1/images/generations", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt/image-model",
      prompt: "circle",
      stream: true,
    }),
  });
  await r.text();
  assert.equal(
    results.at(-1)[2],
    502,
    "An upstream error inside HTTP 200 SSE is recorded as failed",
  );
  assert.equal(results.at(-1)[3], false);
});

test("candidate discovery, endpoint verification and included-only quota guards", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-catalog-"));
  const store = createStore(dataDir);
  t.after(() => {
    store.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let used = 0,
    fail = false,
    email = "one@u.nus.edu";
  const bridge = {
    port: 8317,
    key: "private",
    accounts: () => [{ id: "one", provider: "chatgpt", email }],
    rawAccount: () => ({ access_token: "test" }),
  };
  const fetcher = async (url) => {
    if (url.includes("/wham/usage")) {
      if (fail) throw Error("network");
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: used, limit_window_seconds: 18000 },
        },
      });
    }
    if (url.includes("codex/models"))
      return Response.json({
        models: [{ slug: "new-language", visibility: "hide" }],
      });
    return Response.json({
      data: [{ id: "chatgpt/new-image-model" }, { id: "other/never-import" }],
    });
  };
  const catalog = createCatalog({ bridge, store, fetcher });
  await catalog.refresh(true);
  assert.equal(catalog.list().length, 2);
  const image = catalog.list().find((m) => m.type === "image-generation");
  assert.equal(image.discovery, "bridge-candidate");
  assert.equal(image.verification.status, "untested");
  assert.equal(image.available, false);
  await assert.rejects(catalog.resolve(image.id), /not passed verification/);
  assert.equal(
    (await catalog.resolve(image.id, { allowUnverified: true })).id,
    image.id,
  );
  await catalog.assertIncluded(image);
  catalog.observeResult(image, "/v1/images/generations", 200, true);
  assert.equal(
    catalog.list().find((m) => m.id === image.id).verification.status,
    "passed",
  );
  assert.deepEqual((await catalog.resolve(image.id)).endpoints, [
    "/v1/images/generations",
  ]);
  await assert.rejects(
    catalog.resolve(image.id, { endpoint: "/v1/images/edits" }),
    /not passed verification/,
  );
  catalog.observeResult(image, "/v1/images/edits", 403, false);
  assert.equal(
    catalog.list().find((m) => m.id === image.id).verification.endpoints[
      "/v1/images/generations"
    ].status,
    "passed",
  );
  assert.equal(
    catalog.list().find((m) => m.id === image.id).available,
    true,
    "A failed edit does not remove a successful generation endpoint",
  );
  catalog.observeResult(image, "/v1/images/generations", 403, false);
  assert.equal(catalog.list().find((m) => m.id === image.id).available, false);
  used = 100;
  await assert.rejects(catalog.assertIncluded(image), /exhausted/);
  fail = true;
  await assert.rejects(catalog.assertIncluded(image), /could not be verified/);
  fail = false;
  email = "two@u.nus.edu";
  await catalog.refresh(true);
  assert.equal(
    catalog.list().find((m) => m.id === image.id).verification.status,
    "untested",
    "Checks are scoped to account identity",
  );
  assert.equal(catalog.list().find((m) => m.id === image.id).available, false);
});

test("upstream media response sizes are bounded", async () => {
  await assert.rejects(readResponse(new Response("12345"), 4), /exceeds/);
});
