const fs = require("node:fs");
const path = require("node:path");
const { HttpError } = require("./security");
const { readResponse } = require("./media");

// No model IDs: the plan comes entirely from the current account's catalog.
function verificationPlan(models) {
  return models.flatMap((model) => {
    const routes = model.supportedEndpoints || [];
    return (routes.length ? routes : [null]).map((endpoint) => ({
      model: model.id,
      provider: model.provider,
      endpoint,
      status: model.routable && endpoint ? "pending" : "skipped",
      message:
        model.routable && endpoint
          ? ""
          : model.exclusionReason || "No supported route is available.",
    }));
  });
}

function probeBody(model, endpoint) {
  const body = { model: model.id };
  if (endpoint === "/v1/chat/completions" || endpoint === "/v1/responses") {
    const chat = endpoint === "/v1/chat/completions";
    if (chat) body.messages = [{ role: "user", content: "Reply OK." }];
    else body.input = "Reply OK.";
    if (model.provider === "soclaas")
      body[chat ? "max_tokens" : "max_output_tokens"] = 32;
    // Codex strips token caps; Gemini CLI rejects them. Use only advertised
    // reasoning levels, never rewrite a Gemini reasoning-variant model ID.
    if (model.provider === "chatgpt") {
      const effort = ["none", "minimal", "low", "medium", "high", "xhigh"].find(
        (level) => model.reasoningLevels?.includes(level),
      );
      if (effort) {
        if (chat) body.reasoning_effort = effort;
        else body.reasoning = { effort };
      }
    }
  } else if (endpoint === "/v1/embeddings") body.input = "OK";
  else if (endpoint === "/v1/audio/speech") {
    body.input = "OK";
    body.response_format = "wav";
  } else if (
    ["/v1/images/generations", "/v1/images/edits"].includes(endpoint)
  ) {
    Object.assign(body, {
      prompt: "A blue dot.",
      n: 1,
      quality: "low",
      size: "1024x1024",
    });
  } else if (endpoint !== "/v1/audio/transcriptions") {
    throw new HttpError(400, "No verification probe for this endpoint.");
  }
  if (["/v1/images/edits", "/v1/audio/transcriptions"].includes(endpoint)) {
    const image = endpoint === "/v1/images/edits";
    const name = image ? "square.png" : "ok.wav";
    const form = new FormData();
    for (const [key, value] of Object.entries(body))
      form.set(key, String(value));
    form.set(
      image ? "image" : "file",
      new Blob([fs.readFileSync(path.join(__dirname, "fixtures", name))], {
        type: image ? "image/png" : "audio/wav",
      }),
      name,
    );
    return form;
  }
  return body;
}

// Calls the same authenticated verification route as the Playground, preserving
// quota checks, account scoping, response validation and usage accounting.
function loopbackProbe(base, credentials) {
  return async (model, endpoint, signal) => {
    const body = probeBody(model, endpoint);
    const multipart = body instanceof FormData;
    const response = await fetch(
      `${base}/api/verify?endpoint=${encodeURIComponent(endpoint)}`,
      {
        method: "POST",
        headers: {
          ...credentials,
          ...(multipart ? {} : { "Content-Type": "application/json" }),
        },
        body: multipart ? body : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(310_000)]),
      },
    );
    const bytes = await readResponse(response);
    let message = "Request returned valid output.";
    if (!response.ok) {
      try {
        message = JSON.parse(bytes.toString()).error.message;
      } catch {
        message = `Request failed (HTTP ${response.status}).`;
      }
    }
    return {
      status: response.ok ? "passed" : "failed",
      httpStatus: response.status,
      message: String(message).slice(0, 500),
    };
  };
}

function createVerification() {
  let job = null;
  let controller;
  let completion = Promise.resolve();
  const running = () =>
    job?.status === "running" || job?.status === "cancelling";
  return {
    running,
    snapshot() {
      return job ? structuredClone(job) : null;
    },
    start(models, runProbe) {
      if (running())
        throw new HttpError(409, "A full verification is already running.");
      const results = verificationPlan(models);
      if (!results.some((item) => item.status === "pending"))
        throw new HttpError(
          400,
          "Connect a source with supported models before verifying.",
        );
      const byId = new Map(models.map((model) => [model.id, model]));
      controller = new AbortController();
      const signal = controller.signal;
      job = { status: "running", started: Date.now(), finished: null, results };
      completion = (async () => {
        const stopped = new Map();
        for (const item of results) {
          if (item.status !== "pending") continue;
          if (signal.aborted || stopped.has(item.provider)) {
            item.status = signal.aborted ? "cancelled" : "skipped";
            item.message = signal.aborted
              ? "Cancelled before sending."
              : stopped.get(item.provider);
            continue;
          }
          // Speech already generates audio over this model's realtime WebSocket
          // and records both endpoint checks. Avoid a duplicate paid generation.
          if (item.endpoint === "/v1/realtime") {
            const speech = results.find(
              (result) =>
                result.model === item.model &&
                result.endpoint === "/v1/audio/speech",
            );
            item.status = speech?.status === "passed" ? "passed" : "skipped";
            item.message =
              speech?.status === "passed"
                ? "Verified by the speech check's realtime audio generation."
                : "Realtime verification requires a successful speech check.";
            continue;
          }
          item.status = "running";
          try {
            Object.assign(
              item,
              await runProbe(byId.get(item.model), item.endpoint, signal),
            );
            if ([401, 402, 429, 503].includes(item.httpStatus))
              stopped.set(
                item.provider,
                `Source paused after HTTP ${item.httpStatus}; check its connection or allowance before retrying.`,
              );
          } catch {
            item.status = signal.aborted ? "cancelled" : "failed";
            item.message = signal.aborted
              ? "Cancelled; an in-flight request may still consume allowance."
              : "Request could not complete within the time or response-size limit. No retry was sent.";
          }
        }
        job.status = signal.aborted ? "cancelled" : "completed";
        job.finished = Date.now();
      })();
      return this.snapshot();
    },
    async cancel() {
      if (running()) {
        job.status = "cancelling";
        controller.abort();
      }
      await completion;
      return this.snapshot();
    },
  };
}
module.exports = {
  createVerification,
  verificationPlan,
  probeBody,
  loopbackProbe,
};
