const crypto = require("node:crypto");
const { HttpError } = require("./security");

async function proxyGemini({
  req,
  res,
  body,
  endpoint,
  key,
  model,
  gemini,
  store,
  catalog,
}) {
  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnect);
  const stream = body.stream === true;
  const responses = endpoint === "/v1/responses";
  const id = `${responses ? "resp" : "chatcmpl"}_${crypto.randomUUID()}`;
  const itemId = `msg_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const log = {
    key,
    provider: "gemini",
    model: model.upstreamId,
    endpoint,
    started: Date.now(),
    status: 502,
    stream,
    usage: null,
  };
  let text = "",
    started = false,
    sequence = 0;
  function event(type, data) {
    if (res.destroyed) return;
    const value = responses
      ? { type, sequence_number: sequence++, ...data }
      : data;
    res.write(
      `${responses ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
    );
    if (res.writableLength > 1024 * 1024) controller.abort();
  }
  const response = (status, output = [], usage = null) => ({
    id,
    object: "response",
    created_at: created,
    status,
    model: model.id,
    output,
    usage,
    error: null,
  });
  const item = (status, content = []) => ({
    id: itemId,
    type: "message",
    role: "assistant",
    status,
    content,
  });
  const chunk = (delta, finish_reason = null, usage) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: model.id,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });
  function start() {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    if (responses) {
      event("response.created", { response: response("in_progress") });
      event("response.output_item.added", {
        output_index: 0,
        item: item("in_progress"),
      });
      event("response.content_part.added", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    } else event(null, chunk({ role: "assistant", content: "" }));
  }
  function delta(value) {
    text += value;
    if (!stream || !value) return;
    start();
    if (responses)
      event("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: value,
      });
    else event(null, chunk({ content: value }));
  }
  try {
    res.setHeader("X-Gateway-Provider", "gemini");
    res.setHeader("X-Gateway-Model", model.id);
    const result = await gemini.generate({
      model: model.upstreamId,
      body,
      endpoint,
      signal: controller.signal,
      onText: delta,
    });
    const u = result.usage;
    const valid = (n) => Number.isSafeInteger(n) && n >= 0;
    if (u && valid(u.input_tokens) && valid(u.output_tokens))
      log.usage = {
        input: u.input_tokens,
        output: u.output_tokens,
        total: valid(u.total_tokens)
          ? u.total_tokens
          : u.input_tokens + u.output_tokens,
      };
    const usage = log.usage
      ? {
          prompt_tokens: log.usage.input,
          completion_tokens: log.usage.output,
          total_tokens: log.usage.total,
        }
      : null;
    const responseUsage = usage
      ? {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        }
      : null;
    if (!text) delta(result.response);
    else if (result.response.startsWith(text))
      delta(result.response.slice(text.length));
    else if (stream)
      throw new HttpError(502, "Gemini CLI response changed after streaming.");
    const content = [
      { type: "output_text", text: result.response, annotations: [] },
    ];
    const outputItem = item("completed", content);
    const completed = response("completed", [outputItem], responseUsage);
    log.status = 200;
    if (stream) {
      start();
      if (responses) {
        event("response.output_text.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: result.response,
        });
        event("response.content_part.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: content[0],
        });
        event("response.output_item.done", {
          output_index: 0,
          item: outputItem,
        });
        event("response.completed", { response: completed });
      } else {
        event(null, chunk({}, "stop"));
        if (body.stream_options?.include_usage)
          event(null, { ...chunk({}, null, usage), choices: [] });
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          responses
            ? completed
            : {
                id,
                object: "chat.completion",
                created,
                model: model.id,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: result.response },
                    finish_reason: "stop",
                  },
                ],
                usage,
              },
        ),
      );
    }
  } catch (error) {
    log.status = error.status || 502;
    log.error = error.status ? error.message : "Gemini CLI request failed.";
    if (res.headersSent) {
      if (!res.destroyed) {
        if (responses)
          event("response.failed", {
            response: {
              ...response("failed"),
              error: { code: "gateway_error", message: log.error },
            },
          });
        else
          event(null, { error: { message: log.error, type: "gateway_error" } });
        res.end();
      }
    } else
      throw new HttpError(log.status === 499 ? 502 : log.status, log.error);
  } finally {
    res.removeListener("close", disconnect);
    store.record(log);
    catalog?.observeResult?.(model, endpoint, log.status, log.status === 200);
  }
}
module.exports = { proxyGemini };
