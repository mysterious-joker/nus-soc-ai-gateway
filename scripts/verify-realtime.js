// Explicit live speech-output and audio-input check using the gateway API.
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");
const root = path.resolve(__dirname, "..");
const base = `http://localhost:${process.env.PORT || 4000}`;
async function main() {
  if (!process.argv.includes("--live"))
    throw new Error(
      "Use --live to consume a small amount of subscription allowance.",
    );
  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs
        .readFileSync(
          path.join(
            process.env.GATEWAY_DATA_DIR || path.join(root, "data"),
            "dashboard-token",
          ),
          "utf8",
        )
        .trim(),
    }),
  });
  if (!login.ok) throw new Error("Dashboard login failed");
  const admin = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": (await login.json()).csrf,
    "Content-Type": "application/json",
  };
  let key;
  try {
    const r = await fetch(base + "/api/keys", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "Temporary realtime verification" }),
    });
    if (!r.ok) throw new Error("Could not create verification key");
    key = await r.json();
    const auth = {
      Authorization: `Bearer ${key.token}`,
      "Content-Type": "application/json",
    };
    const models = (
      await (await fetch(base + "/v1/models", { headers: auth })).json()
    ).data;
    const model = models.find(
      (m) =>
        m.type === "realtime-audio" &&
        m.endpoints.includes("/v1/realtime") &&
        m.endpoints.includes("/v1/audio/speech"),
    );
    if (!model)
      throw new Error(
        "No verified realtime model. Run verify-models.js --live --endpoint /v1/audio/speech first.",
      );
    const audio = await fetch(base + "/v1/audio/speech", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: model.id,
        input: "The gateway is ready.",
        response_format: "wav",
      }),
    });
    if (!audio.ok) throw new Error(`Speech HTTP ${audio.status}`);
    const wav = Buffer.from(await audio.arrayBuffer());
    if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF")
      throw new Error("Invalid speech bytes");
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    fs.writeFileSync(path.join(root, "output/verified-speech.wav"), wav, {
      mode: 0o600,
    });
    const ws = new WebSocket(
      base.replace("http:", "ws:") +
        "/v1/realtime?model=" +
        encodeURIComponent(model.id),
      { headers: auth, maxPayload: 16 * 1024 * 1024 },
    );
    const result = await new Promise((resolve, reject) => {
      const events = [];
      let text = "",
        completed = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Realtime test timed out"));
      }, 45_000);
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        reject(new Error(`Realtime HTTP ${res.statusCode}`));
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!completed) reject(new Error("Realtime closed before completion"));
      });
      ws.on("message", (bytes) => {
        const e = JSON.parse(bytes);
        events.push(e.type);
        if (e.type === "session.created") {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: 24000 },
                    turn_detection: null,
                  },
                },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: wav.subarray(44).toString("base64"),
            }),
          );
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          ws.send(
            JSON.stringify({
              type: "response.create",
              response: {
                output_modalities: ["text"],
                instructions:
                  "Transcribe the audio you heard. Return only the spoken words.",
              },
            }),
          );
        }
        if (
          ["response.output_text.delta", "response.text.delta"].includes(e.type)
        )
          text += e.delta || "";
        if (e.type === "error") {
          ws.close();
          reject(new Error(e.error?.code || "Realtime provider error"));
        }
        if (e.type === "response.done") {
          completed = true;
          ws.close();
          resolve({
            checkedAt: new Date().toISOString(),
            model: model.id,
            status:
              e.response?.status === "completed" && /gateway.*ready/i.test(text)
                ? "passed"
                : "failed",
            speechBytes: wav.length,
            transcription: text,
            usage: e.response?.usage,
            eventTypes: [...new Set(events)],
          });
        }
      });
    });
    fs.writeFileSync(
      path.join(root, "output/realtime-gateway-verification.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(result));
    if (result.status !== "passed") process.exitCode = 1;
  } finally {
    if (key)
      await fetch(base + "/api/keys?id=" + encodeURIComponent(key.id), {
        method: "DELETE",
        headers: admin,
      });
    await fetch(base + "/api/session", { method: "DELETE", headers: admin });
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
