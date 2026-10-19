const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const SwaggerParser = require("@apidevtools/swagger-parser");
const { ENDPOINTS } = require("../lib/capabilities");
const { createGateway } = require("../server");
const specFile = path.resolve(__dirname, "../public/openapi.json");

test("OpenAPI contract validates and covers every inference route without fixed model IDs", async () => {
  const spec = await SwaggerParser.validate(specFile);
  assert.deepEqual(
    Object.keys(spec.paths).sort(),
    [...ENDPOINTS, "/v1/models"].sort(),
  );
  assert.deepEqual(spec.security, [{ GatewayKey: [] }]);
  assert.equal(spec.components.securitySchemes.GatewayKey.scheme, "bearer");
  const operationIds = new Set();
  for (const [route, item] of Object.entries(spec.paths)) {
    const op =
      item[route === "/v1/models" || route === "/v1/realtime" ? "get" : "post"];
    assert(op, route);
    assert(!operationIds.has(op.operationId));
    operationIds.add(op.operationId);
    assert(op.responses["401"] && op.responses["403"] && op.responses["429"]);
    assert(op["x-providers"].length);
  }
  assert.equal(spec.components.schemas.Model.properties.id.enum, undefined);
  assert.equal(
    spec.components.schemas.SpeechRequest.additionalProperties,
    false,
  );
  assert.equal(
    spec.components.schemas.SpeechRequest.properties.input.maxLength,
    4000,
  );
  assert(spec.paths["/v1/realtime"].get.responses["101"]);
});

test("reference and contract are readable without a key while inference remains protected", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nus-contract-test-"));
  const app = createGateway({
    port: 0,
    dataDir,
    bridge: {
      status: {},
      notices: [],
      accounts: () => [],
      flows: () => ({}),
      initialize: async () => {},
      start() {},
      stop() {},
    },
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of [
    "/reference",
    "/reference.js",
    "/reference.css",
    "/openapi.json",
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert(
      response.headers
        .get("content-security-policy")
        .includes("script-src 'self'"),
    );
    const text = await response.text();
    assert(
      !text.includes(
        fs.readFileSync(path.join(dataDir, "dashboard-token"), "utf8").trim(),
      ),
    );
  }
  const spec = await (await fetch(base + "/openapi.json")).json();
  assert.deepEqual(spec, JSON.parse(fs.readFileSync(specFile, "utf8")));
  const navigationStatus = await new Promise((resolve, reject) => {
    http
      .get(
        base + "/reference",
        {
          headers: {
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(navigationStatus, 200);
  assert.equal(
    (
      await fetch(base + "/openapi.json", {
        headers: { Origin: "https://example.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/v1/models")).status, 401);
});
