// Exercise the public client API; --live explicitly consumes subscription allowance.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const root = path.resolve(__dirname, "..");
const dataDir = process.env.GATEWAY_DATA_DIR || path.join(root, "data");
const base = `http://localhost:${process.env.PORT || 4000}`;
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Public API smoke test: one discovered model per provider/capability, not an exhaustive model retest.",
  checks: [],
};
const stopped = new Set();
function record(name, passed, details = {}) {
  const result = { name, passed, ...details };
  report.checks.push(result);
  console.log(JSON.stringify(result));
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output/gateway-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}
async function request(route, options = {}) {
  return fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(310_000),
  });
}
async function main() {
  if (!process.argv.includes("--live"))
    throw new Error("Use --live to test with subscription allowance.");
  const login = await request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs
        .readFileSync(path.join(dataDir, "dashboard-token"), "utf8")
        .trim(),
    }),
  });
  if (!login.ok) throw new Error(`Dashboard login HTTP ${login.status}`);
  const admin = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": (await login.json()).csrf,
    "Content-Type": "application/json",
  };
  let key, auth;
  async function status(name, route, options, expected) {
    const r = await request(route, options);
    await r.body?.cancel();
    record(name, r.status === expected, { httpStatus: r.status, expected });
  }
  try {
    const created = await request("/api/keys", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "Temporary public API smoke test" }),
    });
    if (!created.ok) throw new Error(`Key creation HTTP ${created.status}`);
    key = await created.json();
    auth = {
      Authorization: `Bearer ${key.token}`,
      "Content-Type": "application/json",
    };
    await status("Unauthenticated catalog rejected", "/v1/models", {}, 401);
    await status(
      "Invalid app key rejected",
      "/v1/models",
      { headers: { Authorization: "Bearer invalid-smoke-key" } },
      401,
    );
    await status(
      "App key cannot access dashboard",
      "/api/dashboard",
      { headers: auth },
      401,
    );
    await status(
      "Cross-origin request rejected",
      "/v1/models",
      { headers: { ...auth, Origin: "https://example.invalid" } },
      403,
    );
    await status(
      "Dashboard mutation without CSRF rejected",
      "/api/refresh",
      { method: "POST", headers: { Cookie: admin.Cookie } },
      403,
    );
    await status(
      "Unknown model rejected",
      "/v1/chat/completions",
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "smoke/nonexistent",
          messages: [{ role: "user", content: "OK" }],
        }),
      },
      404,
    );
    const catalog = await request("/v1/models", { headers: auth });
    const models = (await catalog.json()).data;
    if (!catalog.ok || !Array.isArray(models))
      throw new Error("Public catalog unavailable");
    record("Authenticated model discovery", models.length > 0, {
      models: models.length,
      providers: [...new Set(models.map((m) => m.owned_by))],
    });
    const choose = (provider, type, endpoint) =>
      models.find(
        (m) =>
          m.owned_by === provider &&
          m.type === type &&
          m.endpoints.includes(endpoint),
      );
    async function probe(model, endpoint, body, validate) {
      if (!model) {
        record(endpoint, false, {
          reason: "No discovered verified model for capability",
        });
        return;
      }
      if (stopped.has(model.owned_by)) {
        record(endpoint, false, {
          model: model.id,
          reason: "Stopped source after HTTP 429",
        });
        return;
      }
      const started = Date.now();
      try {
        const headers = { ...auth };
        if (body instanceof FormData) delete headers["Content-Type"];
        const r = await request(endpoint, {
          method: "POST",
          headers,
          body:
            body instanceof FormData
              ? body
              : JSON.stringify({ model: model.id, ...body }),
        });
        if (r.status === 429) stopped.add(model.owned_by);
        const bytes = Buffer.from(await r.arrayBuffer());
        const evidence = r.ok ? validate(bytes, r) : { valid: false };
        record(endpoint, r.ok && evidence.valid, {
          model: model.id,
          httpStatus: r.status,
          durationMs: Date.now() - started,
          ...evidence,
        });
        return evidence.valid ? bytes : null;
      } catch (error) {
        record(endpoint, false, {
          model: model.id,
          error: error.name,
          durationMs: Date.now() - started,
        });
      }
    }
    for (const provider of ["chatgpt", "gemini", "soclaas"]) {
      await probe(
        choose(provider, "llm", "/v1/chat/completions"),
        "/v1/chat/completions",
        {
          messages: [
            {
              role: "user",
              content: "Reply with exactly OK. Do not use tools.",
            },
          ],
          stream: true,
        },
        (bytes, r) => {
          const events = bytes
            .toString()
            .split(/\r?\n/)
            .filter((x) => x.startsWith("data:"))
            .map((x) => x.slice(5).trim());
          const chunks = events
            .filter((x) => x !== "[DONE]")
            .map((x) => JSON.parse(x));
          const text = chunks
            .map((x) => x.choices?.[0]?.delta?.content || "")
            .join("");
          return {
            valid:
              r.headers.get("content-type")?.includes("text/event-stream") &&
              events.includes("[DONE]") &&
              text.trim().length > 0 &&
              !chunks.some((x) => x.error),
            outputCharacters: text.length,
            chunks: chunks.length,
          };
        },
      );
      await probe(
        choose(provider, "llm", "/v1/responses"),
        "/v1/responses",
        { input: "Reply with exactly OK. Do not use tools." },
        (bytes) => {
          const data = JSON.parse(bytes);
          return {
            valid: Boolean(
              data.output?.some((x) => x.content?.some((c) => c.text?.trim())),
            ),
            usage: data.usage || null,
          };
        },
      );
    }
    await probe(
      choose("soclaas", "embedding", "/v1/embeddings"),
      "/v1/embeddings",
      { input: "Gateway verification" },
      (bytes) => {
        const data = JSON.parse(bytes),
          vector = data.data?.[0]?.embedding;
        return {
          valid:
            Array.isArray(vector) &&
            vector.length > 0 &&
            vector.every(Number.isFinite),
          dimensions: vector?.length,
          usage: data.usage || null,
        };
      },
    );
    const image = await probe(
      choose("chatgpt", "image-generation", "/v1/images/generations"),
      "/v1/images/generations",
      {
        prompt: "A blue circle on a white background.",
        n: 1,
        quality: "low",
        size: "1024x1024",
      },
      (bytes) => {
        const data = JSON.parse(bytes);
        return {
          valid: Boolean(data.data?.[0]?.b64_json || data.data?.[0]?.url),
          usage: data.usage || null,
        };
      },
    );
    const imageData = image && JSON.parse(image).data?.[0]?.b64_json;
    if (imageData) {
      const model = choose("chatgpt", "image-generation", "/v1/images/edits");
      const form = new FormData();
      form.set("model", model?.id || "");
      form.set("prompt", "Change the circle to green.");
      form.set("quality", "low");
      form.set(
        "image",
        new Blob([Buffer.from(imageData, "base64")], { type: "image/png" }),
        "circle.png",
      );
      await probe(model, "/v1/images/edits", form, (bytes) => {
        const data = JSON.parse(bytes);
        return {
          valid: Boolean(data.data?.[0]?.b64_json || data.data?.[0]?.url),
          usage: data.usage || null,
        };
      });
    } else
      record("Image edit fixture", false, {
        reason: "Generation did not return an inline image",
      });
    const speech = await probe(
      choose("chatgpt", "realtime-audio", "/v1/audio/speech"),
      "/v1/audio/speech",
      { input: "The gateway is ready.", response_format: "wav" },
      (bytes) => ({
        valid: bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF",
        audioBytes: bytes.length,
      }),
    );
    if (speech) {
      const model = choose(
        "soclaas",
        "speech-to-text",
        "/v1/audio/transcriptions",
      );
      const form = new FormData();
      form.set("model", model?.id || "");
      form.set("file", new Blob([speech], { type: "audio/wav" }), "speech.wav");
      await probe(model, "/v1/audio/transcriptions", form, (bytes) => {
        const data = JSON.parse(bytes);
        return {
          valid: /gateway.*ready/i.test(data.text || ""),
          transcription: data.text,
        };
      });
    } else
      record("Transcription fixture", false, {
        reason: "Speech generation failed",
      });
    const db = new DatabaseSync(path.join(dataDir, "command_center.db"), {
      readOnly: true,
    });
    try {
      const rows = db
        .prepare(
          "SELECT provider,model,endpoint,status_code,total_tokens,usage_source FROM usage_logs WHERE api_key_id=? ORDER BY id",
        )
        .all(key.id);
      const successful = report.checks.filter(
        (c) => c.model && c.httpStatus === 200 && c.passed,
      );
      record(
        "Successful requests recorded in usage ledger",
        successful.length > 0 &&
          successful.every((c) =>
            rows.some(
              (r) =>
                `${r.provider}/${r.model}` === c.model &&
                r.endpoint === c.name &&
                r.status_code === 200,
            ),
          ),
        { requests: rows.length, usage: rows },
      );
    } finally {
      db.close();
    }
  } finally {
    if (key) {
      await status(
        "Temporary key revoked",
        "/api/keys?id=" + encodeURIComponent(key.id),
        { method: "DELETE", headers: admin },
        200,
      );
      await status(
        "Revoked key rejected",
        "/v1/models",
        { headers: auth },
        401,
      );
    }
    await status(
      "Dashboard session logged out",
      "/api/session",
      { method: "DELETE", headers: admin },
      200,
    );
    await status(
      "Logged-out session rejected",
      "/api/dashboard",
      { headers: admin },
      401,
    );
  }
  report.finishedAt = new Date().toISOString();
  record(
    "Overall",
    report.checks.every((c) => c.passed),
  );
  if (report.checks.some((c) => !c.passed)) process.exitCode = 1;
}
main().catch((error) => {
  record("Test execution", false, { error: error.message });
  process.exitCode = 1;
});
