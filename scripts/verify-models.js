// Explicit opt-in: this consumes included provider allowance. No test runs at startup.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (!args.includes("--live")) {
  console.error(
    "Usage: node scripts/verify-models.js --live [--provider SOURCE] [--audio FILE.wav]",
  );
  process.exit(1);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const root = path.join(__dirname, "..");
const base = `http://localhost:${process.env.PORT || 4000}`;
async function main() {
  const token = fs
    .readFileSync(
      path.join(
        process.env.GATEWAY_DATA_DIR || path.join(root, "data"),
        "dashboard-token",
      ),
      "utf8",
    )
    .trim();
  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error("Dashboard login failed");
  const { csrf } = await login.json();
  const admin = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  const results = [];
  const suffix = [
    option("--provider"),
    option("--endpoint")?.replaceAll("/", "-"),
  ]
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "");
  const report = path.join(
    root,
    "output",
    `model-verification${suffix ? "-" + suffix : ""}.json`,
  );
  const save = () => {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(
      report,
      JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
      { mode: 0o600 },
    );
  };
  try {
    const refresh = await fetch(base + "/api/refresh", {
      method: "POST",
      headers: admin,
    });
    if (!refresh.ok) throw new Error("Catalog refresh failed");
    const snapshot = await (
      await fetch(base + "/api/dashboard", { headers: admin })
    ).json();
    const models = snapshot.models.map((m) => ({
      ...m,
      owned_by: m.provider,
      endpoints: m.supportedEndpoints || m.endpoints,
    }));
    for (const provider of [...new Set(models.map((m) => m.owned_by))]) {
      if (option("--provider") && option("--provider") !== provider) continue;
      for (const model of models.filter((m) => m.owned_by === provider)) {
        if (option("--model") && option("--model") !== model.id) continue;
        if (
          option("--endpoint") &&
          !model.endpoints?.includes(option("--endpoint"))
        )
          continue;
        if (model.routable === false) {
          results.push({
            id: model.id,
            status: "excluded",
            reason: model.exclusionReason || "No active connector",
          });
          save();
          continue;
        }
        let endpoint = model.endpoints?.[0],
          body,
          headers = { ...admin };
        if (model.type === "llm")
          body = {
            model: model.id,
            messages: [
              {
                role: "user",
                content: "Reply with exactly OK. Do not use tools.",
              },
            ],
          };
        else if (model.type === "realtime-audio")
          body = { model: model.id, input: "OK", response_format: "wav" };
        else if (model.type === "embedding")
          body = { model: model.id, input: "Gateway verification" };
        else if (model.type === "image-generation")
          body = {
            model: model.id,
            prompt: "One blue circle on a plain white background.",
            n: 1,
            quality: "low",
            size: "1024x1024",
          };
        else if (model.type === "speech-to-text" && option("--audio")) {
          body = new FormData();
          body.set("model", model.id);
          body.set(
            "file",
            new Blob([fs.readFileSync(option("--audio"))], {
              type: "audio/wav",
            }),
            "verification.wav",
          );
          headers = { ...admin };
          delete headers["Content-Type"];
        } else {
          results.push({
            id: model.id,
            status: "skipped",
            reason: "No fixture for this capability",
          });
          save();
          continue;
        }
        if (option("--endpoint") === "/v1/images/edits") {
          if (!option("--image"))
            throw new Error("Image editing verification requires --image FILE");
          endpoint = "/v1/images/edits";
          body = new FormData();
          headers = { ...admin };
          delete headers["Content-Type"];
          body.set("model", model.id);
          body.set(
            "prompt",
            "Make the circle green. Keep the plain white background.",
          );
          body.set("quality", "low");
          body.set(
            "image",
            new Blob([fs.readFileSync(option("--image"))], {
              type: "image/png",
            }),
            "fixture.png",
          );
        } else if (option("--endpoint")) {
          endpoint = option("--endpoint");
          if (endpoint === "/v1/responses")
            body = {
              model: model.id,
              input: "Reply with exactly OK. Do not use tools.",
            };
        }
        const start = Date.now();
        let result;
        try {
          const r = await fetch(
            base + "/api/verify?endpoint=" + encodeURIComponent(endpoint),
            {
              method: "POST",
              headers,
              body: body instanceof FormData ? body : JSON.stringify(body),
              signal: AbortSignal.timeout(310_000),
            },
          );
          if (model.type === "realtime-audio" && r.ok) {
            const audio = Buffer.from(await r.arrayBuffer());
            const valid =
              audio.length > 44 && audio.toString("ascii", 0, 4) === "RIFF";
            result = {
              id: model.id,
              endpoint,
              status: valid ? "passed" : "failed",
              httpStatus: r.status,
              audioBytes: audio.length,
              durationMs: Date.now() - start,
            };
            results.push(result);
            save();
            console.log(JSON.stringify(result));
            continue;
          }
          const data = await r.json();
          const valid =
            r.ok &&
            (model.type === "llm"
              ? Boolean(
                  endpoint === "/v1/responses"
                    ? data.output?.some((x) =>
                        x.content?.some((c) => c.text?.trim()),
                      )
                    : data.choices?.[0]?.message?.content?.trim(),
                )
              : model.type === "embedding"
                ? data.data?.[0]?.embedding?.length > 0
                : model.type === "image-generation"
                  ? Boolean(data.data?.[0]?.b64_json || data.data?.[0]?.url)
                  : typeof data.text === "string" && Boolean(data.text.trim()));
          result = {
            id: model.id,
            endpoint,
            status: valid ? "passed" : "failed",
            httpStatus: r.status,
            durationMs: Date.now() - start,
            usage: data.usage || null,
            ...(data.error ? { error: data.error.message } : {}),
          };
          // Keep one test image for the separately exercised editing endpoint; never store prompts or audio.
          if (
            valid &&
            endpoint === "/v1/images/generations" &&
            data.data[0].b64_json
          )
            fs.writeFileSync(
              path.join(root, "output/verification-image.png"),
              Buffer.from(data.data[0].b64_json, "base64"),
              { mode: 0o600 },
            );
        } catch (e) {
          result = {
            id: model.id,
            endpoint,
            status: "failed",
            error: e.name,
            durationMs: Date.now() - start,
          };
        }
        results.push(result);
        save();
        console.log(JSON.stringify(result));
        if (result.httpStatus === 429) {
          console.log(
            `${provider}: stopped after quota/rate-limit response; remaining entries are untested.`,
          );
          break;
        }
      }
    }
    if (!results.length || results.some((r) => r.status === "failed"))
      process.exitCode = 1;
    if (!results.length)
      console.error(
        "No matching candidates. Connect a source and check the model ID or endpoint.",
      );
  } finally {
    await fetch(base + "/api/session", { method: "DELETE", headers: admin });
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
