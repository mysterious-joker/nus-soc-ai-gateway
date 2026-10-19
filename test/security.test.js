const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { domainAllowed, localRequest } = require("../lib/security");
const {
  verifyIdToken,
  verifyIdentity,
  parseCodexQuota,
  normalizeModel,
} = require("../lib/providers");
const { reportedUsage, createSseUsageParser } = require("../lib/proxy");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", use: "sig" }],
};
function token(overrides = {}, signer = privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: ["app_EMoamEEZ73f0CkXaXp7hrann"],
      sub: "student",
      email: "student@u.nus.edu",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    }),
  ).toString("base64url");
  const data = header + "." + claims;
  return (
    data +
    "." +
    crypto.sign("RSA-SHA256", Buffer.from(data), signer).toString("base64url")
  );
}
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
test("exact institutional domains reject suffix tricks and malformed email", () => {
  assert(domainAllowed("Student@U.NUS.EDU", "u.nus.edu"));
  for (const email of [
    "x@u.nus.edu.evil.test",
    "x@@u.nus.edu",
    "x@nus.edu",
    "x@u.nus.edu\n",
    "x@comp.nus.edu.sg",
  ])
    assert(!domainAllowed(email, "u.nus.edu"));
});
test("host and origin checks stop cross-site and DNS rebinding requests", () => {
  const navigation = {
    method: "GET",
    url: "/",
    headers: {
      host: "localhost:4000",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  };
  localRequest(navigation, 4000);
  assert.throws(() =>
    localRequest({ ...navigation, url: "/api/dashboard" }, 4000),
  );
  assert.throws(() => localRequest({ ...navigation, method: "POST" }, 4000));
  localRequest(
    { headers: { host: "localhost:4000", origin: "http://localhost:4000" } },
    4000,
  );
  for (const headers of [
    { host: "evil.test:4000" },
    { host: "localhost:4000", origin: "https://evil.test" },
    { host: "localhost:4000", "sec-fetch-site": "cross-site" },
  ])
    assert.throws(
      () => localRequest({ headers }, 4000),
      (e) => e.status === 403,
    );
});
test("identity validation verifies signature, issuer, audience, expiry and verified email", () => {
  assert.equal(verifyIdToken(token(), jwks).email, "student@u.nus.edu");
  for (const override of [
    { iss: "https://evil.test" },
    { aud: ["wrong"] },
    { exp: 1 },
    { email_verified: false },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ])
    assert.throws(() => verifyIdToken(token(override), jwks));
  const another = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => verifyIdToken(token({}, another.privateKey), jwks));
});
test("signed wrong-domain ChatGPT identity is rejected despite spoofed stored email", async () => {
  await assert.rejects(
    verifyIdentity(
      "chatgpt",
      {
        type: "codex",
        access_token: "fake",
        id_token: token({ email: "x@example.com" }),
        email: "student@u.nus.edu",
      },
      async () => json(jwks),
    ),
    /requires an @u.nus.edu/,
  );
});
test("quota preserves exhausted zero balances and reports windows independently", () => {
  const q = parseCodexQuota({
    rate_limit: {
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 18000,
        reset_at: 1800000000,
      },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    },
    credits: { balance: 0 },
  });
  assert.equal(q.windows[0].remainingPercent, 0);
  assert.equal(q.windows[1].remainingPercent, 80);
  assert.equal(q.credits.balance, 0);
  assert.equal(parseCodexQuota({}).credits, null);
});
test("model namespaces and type metadata are retained", () => {
  const m = normalizeModel("soclaas", {
    id: "shared-model",
    model_info: { mode: "embedding", max_input_tokens: 8192 },
  });
  assert.equal(m.id, "soclaas/shared-model");
  assert.equal(m.type, "embedding");
  assert.equal(m.contextWindow, 8192);
  assert.equal(normalizeModel("soclaas", { id: "m\nbad" }), null);
});
test("usage counts are reported only and support Chat Completions and Responses", () => {
  assert.equal(
    reportedUsage({ choices: [{ message: { content: "Hello" } }] }),
    null,
  );
  assert.deepEqual(
    reportedUsage({
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { input: 0, output: 0, total: 0 },
  );
  assert.deepEqual(
    reportedUsage({
      response: { usage: { input_tokens: 12, output_tokens: 8 } },
    }),
    { input: 12, output: 8, total: 20 },
  );
});
test("SSE usage survives arbitrary chunk boundaries and final unterminated events", () => {
  const parser = createSseUsageParser();
  const event =
    "data: " +
    JSON.stringify({
      type: "response.completed",
      response: {
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    });
  for (const char of event) parser.push(char);
  assert.deepEqual(parser.finish(), { input: 9, output: 4, total: 13 });
});

test("SoCLaaS nested metadata supplies task type and display name", () => {
  const m = normalizeModel("soclaas", {
    id: "provider-id",
    soclaas: { display_name: "Provider model", capabilities: ["embeddings"] },
  });
  assert.equal(m.type, "embedding");
  assert.equal(m.name, "Provider model");
  assert.equal(m.classification, "provider");
});
test("expired dashboard sessions cannot administer the gateway", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createSessions } = require("../lib/security");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nus-session-test-"));
  const sessions = createSessions(dir);
  let cookie;
  const session = sessions.login(
    fs.readFileSync(path.join(dir, "dashboard-token"), "utf8"),
    {
      setHeader(name, value) {
        cookie = value.split(";")[0];
      },
    },
  );
  const req = { headers: { cookie, "x-csrf-token": session.csrf } };
  assert(sessions.require(req, true));
  const now = Date.now;
  try {
    Date.now = () => now() + 9 * 3600_000;
    assert.throws(
      () => sessions.require(req),
      (e) => e.status === 401,
    );
  } finally {
    Date.now = now;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
