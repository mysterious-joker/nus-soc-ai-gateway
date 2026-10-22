const { once } = require("node:events");
const { HttpError } = require("./security");
const { SOCLAAS_BASE } = require("./providers");
const { proxyGemini } = require("./gemini-proxy");
const { endpoints } = require("./capabilities");
const { readResponse } = require("./media");
const { inferenceFetch } = require("./inference-http");
function reportedUsage(data) {
  const u = data?.usage || data?.response?.usage;
  if (!u || typeof u !== "object") return null;
  const input = u.prompt_tokens ?? u.input_tokens;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const valid = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!valid(input) || !valid(output)) return null;
  return {
    input,
    output,
    total: valid(u.total_tokens) ? u.total_tokens : input + output,
  };
}
function createSseUsageParser(limit = 4 * 1024 * 1024) {
  let buffer = "";
  let usage = null;
  let failed = false;
  function line(text) {
    if (!text.startsWith("data:")) return;
    try {
      const data = JSON.parse(text.slice(5).trim());
      if (
        data.error ||
        ["error", "response.failed", "response.incomplete"].includes(
          data.type,
        ) ||
        ["failed", "incomplete"].includes(data.response?.status)
      )
        failed = true;
      const found = reportedUsage(data);
      if (found) usage = found;
    } catch {}
  }
  return {
    push(text) {
      buffer += text;
      if (buffer.length > limit)
        throw new HttpError(502, "Upstream event exceeded the supported size.");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
    },
    finish() {
      if (buffer) line(buffer);
      return usage;
    },
    get usage() {
      return usage;
    },
    get failed() {
      return failed;
    },
  };
}
function compatible(model, endpoint) {
  if (!endpoints(model).includes(endpoint))
    throw new HttpError(
      400,
      `This ${model.type} model does not support ${endpoint} through its connector.`,
    );
}
async function proxy({
  req,
  res,
  body,
  form,
  endpoint,
  key,
  catalog,
  bridge,
  store,
  gemini,
  allowUnverified = false,
  fetcher = inferenceFetch,
}) {
  const model = await catalog.resolve(body.model, {
    allowUnverified,
    endpoint,
  });
  compatible(model, endpoint);
  await catalog.assertIncluded?.(model);
  const isStream = body.stream === true;
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new HttpError(400, "stream must be true or false.");
  if (model.provider === "gemini")
    return proxyGemini({
      req,
      res,
      body,
      endpoint,
      key,
      model,
      gemini,
      store,
      catalog,
    });
  const payload = {
    ...body,
    model: model.provider === "soclaas" ? model.upstreamId : model.id,
  };
  if (isStream && endpoint === "/v1/chat/completions")
    payload.stream_options = { ...body.stream_options, include_usage: true };
  if (form) form.set("model", payload.model);
  const target =
    model.provider === "soclaas"
      ? `${SOCLAAS_BASE}${endpoint.slice(3)}`
      : `http://127.0.0.1:${bridge.port}${endpoint}`;
  const token = model.provider === "soclaas" ? store.soclaasKey() : bridge.key;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    model.provider === "chatgpt" &&
      ["/v1/chat/completions", "/v1/responses"].includes(endpoint)
      ? 600_000
      : endpoint.startsWith("/v1/images/")
        ? 300_000
        : 120_000,
  );
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnect);
  const log = {
    key,
    provider: model.provider,
    model: model.upstreamId,
    endpoint,
    started: Date.now(),
    status: 502,
    stream: isStream,
    usage: null,
  };
  try {
    const requestOptions = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(!form ? { "Content-Type": "application/json" } : {}),
        Accept: isStream ? "text/event-stream" : "application/json",
      },
      body: form || JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    };
    const upstream = await fetcher(target, requestOptions);
    log.status = upstream.status;
    for (const header of [
      "retry-after",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-tokens",
    ])
      if (upstream.headers.has(header))
        res.setHeader(header, upstream.headers.get(header));
    catalog.observeHeaders?.(model.provider, upstream.headers);
    res.setHeader("X-Gateway-Provider", model.provider);
    res.setHeader("X-Gateway-Model", model.id);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      log.error = `Upstream HTTP ${upstream.status}`;
      throw new HttpError(
        upstream.status,
        `The ${model.provider} provider returned HTTP ${upstream.status}. ${upstream.status === 401 ? "Reconnect the account." : upstream.status === 429 ? "Check remaining quota and retry after the reset." : "Check model access or try another model."}`,
      );
    }
    if (!isStream) {
      const text = (await readResponse(upstream)).toString("utf8");
      if (
        endpoint === "/v1/audio/transcriptions" &&
        ["text", "srt", "vtt"].includes(body.response_format)
      ) {
        res.writeHead(upstream.status, {
          "Content-Type":
            body.response_format === "vtt"
              ? "text/vtt; charset=utf-8"
              : "text/plain; charset=utf-8",
        });
        res.end(text);
        return;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError(502, "Provider returned a non-JSON response.");
      }
      if (
        data.error ||
        (endpoint.startsWith("/v1/images/") &&
          !data.data?.some((x) => x.b64_json || x.url))
      )
        throw new HttpError(
          502,
          "Provider did not return a successful generation.",
        );
      log.usage = reportedUsage(data);
      if (
        endpoint === "/v1/chat/completions" &&
        !data.choices?.some(
          (c) =>
            (typeof c.message?.content === "string" &&
              c.message.content.trim()) ||
            (Array.isArray(c.message?.content) && c.message.content.length) ||
            c.message?.tool_calls?.length ||
            c.message?.function_call,
        )
      )
        throw new HttpError(502, "Provider returned no assistant output.");
      if (
        endpoint === "/v1/responses" &&
        !data.output?.length &&
        !data.output_text?.trim()
      )
        throw new HttpError(502, "Provider returned no response output.");
      if (
        (endpoint === "/v1/audio/transcriptions" &&
          typeof data.text !== "string") ||
        (endpoint === "/v1/embeddings" &&
          !Array.isArray(data.data?.[0]?.embedding))
      )
        throw new HttpError(
          502,
          "Provider returned an invalid result for this endpoint.",
        );
      if (typeof data.model === "string") data.model = model.id;
      res.writeHead(upstream.status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    } else {
      if (!upstream.headers.get("content-type")?.includes("text/event-stream"))
        throw new HttpError(502, "Provider did not return an event stream.");
      res.writeHead(upstream.status, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const parser = createSseUsageParser(
        endpoint.startsWith("/v1/images/") ? 64 * 1024 * 1024 : undefined,
      );
      const decoder = new TextDecoder();
      try {
        for await (const chunk of upstream.body) {
          parser.push(decoder.decode(chunk, { stream: true }));
          if (!res.write(chunk))
            await once(res, "drain", { signal: controller.signal });
        }
        parser.push(decoder.decode());
        log.usage = parser.finish();
        if (parser.failed)
          throw new HttpError(
            502,
            "Provider reported a failed or incomplete stream.",
          );
        res.end();
      } finally {
        log.usage = log.usage || parser.usage;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      log.status = res.destroyed ? 499 : 504;
      log.error = res.destroyed
        ? "Client disconnected"
        : "Upstream request timed out";
    } else {
      log.status = error.status || 502;
      log.error = error.status ? error.message : "Upstream connection failed";
    }
    if (res.headersSent) {
      if (!res.destroyed)
        res.end(
          `event: error\ndata: ${JSON.stringify({ error: { message: log.error } })}\n\n`,
        );
    } else
      throw new HttpError(log.status === 499 ? 502 : log.status, log.error);
  } finally {
    clearTimeout(timeout);
    res.removeListener("close", disconnect);
    store.record(log);
    catalog.observeResult?.(
      model,
      endpoint,
      log.status,
      log.status >= 200 && log.status < 300,
    );
  }
}
module.exports = { reportedUsage, createSseUsageParser, compatible, proxy };
