const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createGeminiCli,
  identityFromLog,
  parseModels,
  conversation,
} = require("../lib/gemini-cli");
const { createGateway } = require("../server");
const { createStore } = require("../lib/store");
const account = {
  email: "test@comp.nus.edu.sg",
  project: "school-subscription",
};
const identityLog = `ChainedAuth: authenticated via keyring (effective: gcp)\napplyAuthResult: email=${account.email}, authMethod=gcp, quotaProject=${account.project}\nloaded 1 named hooks from 1 hooks.json file(s)`;

test("Gemini requires a school keyring identity and rejects account or project changes", () => {
  assert.deepEqual(identityFromLog(identityLog), account);
  for (const log of [
    identityLog.replace("test@comp.nus.edu.sg", "test@gmail.com"),
    identityLog.replace("comp.nus.edu.sg", "comp.nus.edu.sg.evil.test"),
    identityLog.replace("via keyring", "via adc"),
    "",
  ])
    assert.throws(() => identityFromLog(log), /subscription account/);
  assert.throws(
    () => identityFromLog(identityLog, { ...account, project: "other" }),
    /changed/,
  );
  assert.throws(
    () =>
      identityFromLog(identityLog, {
        ...account,
        email: "other@comp.nus.edu.sg",
      }),
    /changed/,
  );
});
test("Gemini model discovery has no static IDs and input rejects unsupported features", () => {
  assert.deepEqual(
    parseModels("future-model-high\tFuture model (High)\n").map((m) => m.id),
    ["gemini/future-model-high"],
  );
  assert.throws(() => parseModels("invalid output"), /catalog/);
  assert.match(
    conversation({ input: "你好", instructions: "Be brief." }, "/v1/responses"),
    /你好/,
  );
  for (const body of [
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: "private" }],
        },
      ],
    },
    { messages: [{ role: "tool", content: "tool result" }] },
    { messages: [{ role: "user", content: "Hi" }], tools: [] },
    { messages: [{ role: "user", content: "Hi" }], temperature: 0.1 },
  ])
    assert.throws(() => conversation(body, "/v1/chat/completions"), /support/);
});

function fixture(t, mode = "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-cli-test-"));
  const executable = path.join(dir, "agy-fixture");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2), log=args[args.indexOf('--log-file')+1];
fs.writeFileSync(log,${JSON.stringify(mode === "wrong-account" ? identityLog.replace(account.email, "outsider@gmail.com") : identityLog)});
if(args.includes('models')){console.log('server-model\\tServer model');process.exit(0)}
console.log(JSON.stringify({event:'init',init:{model:args[args.indexOf('--model')+1],agent:'gateway-chat',permission_mode:'request-review'}}));
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(path.join(dir, "prompt-received"))},'yes');
 if(${JSON.stringify(mode)}==='hang') {setInterval(()=>{},1000);return;}
 if(${JSON.stringify(mode)}!=='no-hook') fs.writeFileSync(process.env.NUS_GATEWAY_HOOK_READY,'ready');
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'你好'}}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'你好',usage:{input_tokens:7,output_tokens:2,total_tokens:9}}}));
});
`,
    { mode: 0o700 },
  );
  let saved = account;
  const store = {
    get: () => saved,
    set: (k, v) => {
      saved = v;
    },
  };
  const gemini = createGeminiCli({ dataDir: dir, store, binary: executable });
  t.after(() => {
    gemini.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, gemini };
}
const generate = (gemini) =>
  gemini.generate({
    model: "server-model",
    body: { messages: [{ role: "user", content: "Hi" }] },
    endpoint: "/v1/chat/completions",
  });
test("CLI adapter validates identity before transmitting the prompt and requires active hooks", async (t) => {
  const good = fixture(t);
  assert.equal(
    (await good.gemini.connect()).models[0].id,
    "gemini/server-model",
  );
  assert.equal((await generate(good.gemini)).response, "你好");
  const bad = fixture(t, "wrong-account");
  await assert.rejects(generate(bad.gemini), /subscription account/);
  assert.equal(fs.existsSync(path.join(bad.dir, "prompt-received")), false);
  const noHook = fixture(t, "no-hook");
  await assert.rejects(
    generate(noHook.gemini),
    /restrictions were not activated/,
  );
});
test("CLI disconnect cancels an active process and blocks subsequent requests", async (t) => {
  const { dir, gemini } = fixture(t, "hang");
  const request = generate(gemini);
  const rejected = assert.rejects(request, /disconnected/);
  for (
    let i = 0;
    i < 100 && !fs.existsSync(path.join(dir, "prompt-received"));
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  gemini.disconnect();
  await rejected;
  await assert.rejects(generate(gemini), /Connect Gemini/);
});

test("Gemini routes chat and Responses streaming through the adapter and records reported usage", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-http-test-"));
  const store = createStore(dir);
  const key = store.createKey("test");
  const model = {
    id: "gemini/server-model",
    upstreamId: "server-model",
    provider: "gemini",
    type: "llm",
    available: true,
  };
  let calls = 0;
  const gemini = {
    stop() {},
    async generate({ onText, body, endpoint }) {
      conversation(body, endpoint);
      calls++;
      onText("Hello ");
      onText("世界");
      return {
        response: "Hello 世界",
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      };
    },
  };
  const app = createGateway({
    port: 0,
    dataDir: dir,
    store,
    gemini,
    bridge: {
      accounts: () => [],
      initialize: async () => {},
      start() {},
      stop() {},
    },
    catalog: {
      resolve: async () => model,
      refresh: async () => {},
      list: () => [model],
      sources: () => [],
    },
    fetcher: () => {
      throw new Error("Gemini must not use Vertex or CLIProxyAPI");
    },
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = {
    Authorization: `Bearer ${key.token}`,
    "Content-Type": "application/json",
  };
  for (const stream of [false, true])
    for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
      const r = await fetch(base + endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.id,
          stream,
          ...(endpoint.endsWith("responses")
            ? { input: "Hi" }
            : {
                messages: [{ role: "user", content: "Hi" }],
                stream_options: { include_usage: true },
              }),
        }),
      });
      assert.equal(r.status, 200);
      const data = await r.text();
      assert.match(data, /世界/);
      assert.match(data, /total_tokens/);
      if (stream)
        assert.match(
          data,
          endpoint.endsWith("responses") ? /response.completed/ : /\[DONE\]/,
        );
    }
  assert.equal(calls, 4);
  assert.equal(store.analytics().totals.tokens, 36);
});
