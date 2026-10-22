const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { proxy } = require("../lib/proxy");

function fixture(
  t,
  {
    endpoint = "/v1/chat/completions",
    stream = false,
    provider = "chatgpt",
  } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const res = new EventEmitter();
  Object.assign(res, {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    output: "",
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    write(chunk) {
      this.output += Buffer.from(chunk).toString();
      return true;
    },
    end(chunk = "") {
      this.output += chunk;
      this.writableEnded = true;
    },
  });
  const logs = [],
    observations = [];
  let signal, resolve, started;
  const ready = new Promise((r) => {
    started = r;
  });
  const model = {
    id: `${provider}/reasoner`,
    upstreamId: "reasoner",
    provider,
    type: "llm",
  };
  const request = proxy({
    req: {},
    res,
    endpoint,
    body: { model: model.id, stream },
    key: "synthetic-key",
    bridge: { port: 8317, key: "synthetic-bridge-key" },
    catalog: {
      resolve: async () => model,
      observeResult: (...args) => observations.push(args),
    },
    store: {
      record: (log) => logs.push(log),
      soclaasKey: () => "synthetic-soc-key",
    },
    fetcher: async (_url, options) => {
      signal = options.signal;
      if (stream) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        });
        started();
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Promise((success, reject) => {
        resolve = success;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started();
      });
    },
  });
  // Attach rejection handling before advancing the clock.
  const result = request.then(
    () => null,
    (error) => error,
  );
  return {
    res,
    logs,
    observations,
    result,
    ready,
    get signal() {
      return signal;
    },
    succeed() {
      resolve(
        Response.json(
          endpoint === "/v1/responses"
            ? {
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "OK" }],
                  },
                ],
              }
            : { choices: [{ message: { content: "OK" } }] },
        ),
      );
    },
  };
}

for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
  test(`${endpoint}: ChatGPT can complete after 590s without hitting the old 120s limit`, async (t) => {
    const f = fixture(t, { endpoint });
    await f.ready;
    t.mock.timers.tick(590_000);
    assert.equal(f.signal.aborted, false);
    f.succeed();
    assert.equal(await f.result, null);
    assert.equal(f.res.statusCode, 200);
    assert.match(f.res.output, /OK/);
    assert.equal(f.logs[0].status, 200);
    t.mock.timers.tick(60_000);
    assert.equal(
      f.signal.aborted,
      false,
      "completed request timer was cleared",
    );
    assert.equal(f.res.listenerCount("close"), 0);
  });
  test(`${endpoint}: ChatGPT aborts at the bounded 600s deadline and records failure`, async (t) => {
    const f = fixture(t, { endpoint });
    await f.ready;
    t.mock.timers.tick(599_999);
    assert.equal(f.signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal((await f.result).status, 504);
    assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0].status, 504);
    assert.equal(f.observations[0][3], false);
    assert.equal(f.res.listenerCount("close"), 0);
  });
}

test("ChatGPT streaming retains its total deadline after partial output", async (t) => {
  const f = fixture(t, { stream: true });
  await f.ready;
  for (let i = 0; i < 20 && !f.res.output; i++) await Promise.resolve();
  assert.match(f.res.output, /partial/);
  t.mock.timers.tick(599_999);
  assert.equal(f.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(await f.result, null);
  assert.match(f.res.output, /event: error/);
  assert.doesNotMatch(f.res.output, /\[DONE\]|response.completed/);
  assert.equal(f.logs[0].status, 504);
  assert.equal(f.observations[0][3], false);
});

test("caller disconnect cancels ChatGPT immediately instead of waiting 600s", async (t) => {
  const f = fixture(t);
  await f.ready;
  f.res.destroyed = true;
  f.res.emit("close");
  assert.equal(f.signal.aborted, true);
  await f.result;
  assert.equal(f.logs[0].status, 499);
  assert.equal(f.logs[0].error, "Client disconnected");
  assert.equal(f.res.listenerCount("close"), 0);
});

test("SoCLaaS retains its existing 120s inference deadline", async (t) => {
  const f = fixture(t, { provider: "soclaas" });
  await f.ready;
  t.mock.timers.tick(119_999);
  assert.equal(f.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await f.result).status, 504);
});
