const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { inferenceFetch } = require("../lib/inference-http");

test("inference transport preserves native multipart uploads and repeated image fields", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      contentType: req.headers["content-type"],
      bytes: Buffer.concat(chunks),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const form = new FormData();
  form.set("model", "synthetic-image");
  form.append(
    "image[]",
    new Blob(["first"], { type: "image/png" }),
    "first.png",
  );
  form.append(
    "image[]",
    new Blob(["second"], { type: "image/png" }),
    "second.png",
  );
  const response = await inferenceFetch(
    `http://127.0.0.1:${server.address().port}`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(received.contentType, /^multipart\/form-data; boundary=/);
  const decoded = await new Response(received.bytes, {
    headers: { "Content-Type": received.contentType },
  }).formData();
  assert.equal(decoded.get("model"), "synthetic-image");
  const images = decoded.getAll("image[]");
  assert.deepEqual(
    images.map((file) => [file.name, file.type]),
    [
      ["first.png", "image/png"],
      ["second.png", "image/png"],
    ],
  );
  assert.deepEqual(await Promise.all(images.map((file) => file.text())), [
    "first",
    "second",
  ]);
});
