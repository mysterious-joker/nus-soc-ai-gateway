"use strict";
const byId = (id) => document.getElementById(id);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function codeBlock(label, text) {
  const container = element("div", undefined, "reference-code");
  const header = element("div", undefined, "reference-code-head");
  const status = element("span", label);
  status.setAttribute("aria-live", "polite");
  const copy = element("button", "Copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Copy ${label}`);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Select the example and copy it manually.";
    }
  });
  header.append(status, copy);
  const pre = element("pre");
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", label);
  pre.append(element("code", text));
  container.append(header, pre);
  return container;
}
function shellQuote(text) {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
function curlExample(route, method, mime, example) {
  const lines = [
    `curl ${location.origin}${route}`,
    '  -H "Authorization: Bearer $NUS_GATEWAY_KEY"',
  ];
  if (method === "post") {
    if (mime === "multipart/form-data") {
      for (const [name, value] of Object.entries(example || {}))
        lines.push(`  -F ${shellQuote(`${name}=${value}`)}`);
    } else {
      lines.push("  -H 'Content-Type: application/json'");
      lines.push(`  -d ${shellQuote(JSON.stringify(example, null, 2))}`);
    }
    if (route === "/v1/audio/speech") lines.push("  --output speech.wav");
  }
  return lines.join(" \\\n");
}
async function render() {
  byId("client-base").textContent = location.origin + "/v1";
  byId("setup-example").replaceWith(
    codeBlock(
      "Terminal setup",
      `export NUS_GATEWAY_KEY='YOUR_LOCAL_GATEWAY_KEY'\n\n${curlExample("/v1/models", "get")}`,
    ),
  );
  const response = await fetch("/openapi.json", { credentials: "omit" });
  if (!response.ok) throw new Error("Contract unavailable");
  const contract = await response.json();
  const resolve = (schema) =>
    schema?.$ref
      ? contract.components.schemas[schema.$ref.split("/").at(-1)]
      : schema;
  for (const [route, path] of Object.entries(contract.paths)) {
    const [method, operation] = Object.entries(path)[0];
    const anchor = element("a", operation.summary);
    anchor.href = "#" + operation.operationId;
    byId("endpoint-nav").append(anchor);
    const section = element("section", undefined, "reference-section");
    section.id = operation.operationId;
    section.append(element("h2", operation.summary));
    const routeLine = element("div", undefined, "reference-route");
    routeLine.append(
      element(
        "span",
        operation["x-websocket"] ? "WEBSOCKET" : method.toUpperCase(),
        "reference-method",
      ),
      element("code", route),
    );
    section.append(
      routeLine,
      element("p", operation.description),
      element("p", operation["x-providers"].join(" · "), "reference-providers"),
    );
    const content = operation.requestBody?.content;
    const mime = content && Object.keys(content)[0];
    const request = mime && content[mime];
    const schema = resolve(request?.schema);
    const fields =
      schema?.properties ||
      Object.fromEntries(
        (operation.parameters || []).map((p) => [p.name, p.schema]),
      );
    if (Object.keys(fields).length) {
      section.append(
        element(
          "h3",
          mime === "multipart/form-data"
            ? "Upload fields"
            : operation.parameters
              ? "Query parameters"
              : "Request fields",
        ),
      );
      const list = element("dl", undefined, "reference-fields");
      for (const [name, property] of Object.entries(fields)) {
        const field = resolve(property);
        const row = element("div"),
          term = element("dt"),
          description = element("dd");
        term.append(element("code", name));
        if (
          schema?.required?.includes(name) ||
          operation.parameters?.find((p) => p.name === name)?.required
        )
          term.append(element("span", "Required", "reference-required"));
        const types =
          field.type ||
          field.oneOf?.map((s) => s.type).join(" or ") ||
          "object";
        description.append(
          element("small", Array.isArray(types) ? types.join(" or ") : types),
        );
        description.append(
          document.createTextNode(
            field.description ||
              (name === "messages"
                ? "Conversation messages with role and content. See the JSON example below."
                : "See the request example and downloadable schema."),
          ),
        );
        if (field.enum)
          description.append(element("p", "Values: " + field.enum.join(", ")));
        row.append(term, description);
        list.append(row);
      }
      section.append(list);
    }
    if (operation["x-websocket"]) {
      section.append(
        codeBlock(
          "Node.js WebSocket example",
          `// Uses the ws package. Replace the model ID with a verified realtime model.\nconst { WebSocket } = require("ws");\nconst model = "PROVIDER/MODEL_FROM_YOUR_CATALOG";\nconst ws = new WebSocket(\n  "${location.origin.replace("http:", "ws:")}${route}?model=" + encodeURIComponent(model),\n  { headers: { Authorization: "Bearer " + process.env.NUS_GATEWAY_KEY } }\n);\nws.on("error", console.error);\nws.on("message", bytes => {\n  const event = JSON.parse(bytes);\n  if (event.type === "session.created") {\n    ws.send(JSON.stringify(${JSON.stringify(operation["x-websocket"].sendExample)}));\n  }\n  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);\n  if (event.type === "response.done" || event.type === "error") ws.close();\n});`,
        ),
      );
      section.append(
        codeBlock(
          "Example incoming event",
          JSON.stringify(operation["x-websocket"].receiveExample, null, 2),
        ),
      );
    } else {
      section.append(
        codeBlock(
          "cURL request",
          curlExample(route, method, mime, request?.example),
        ),
      );
      if (request?.example) {
        const details = element("details");
        details.append(
          element(
            "summary",
            mime === "multipart/form-data"
              ? "Example upload values"
              : "Example JSON body",
          ),
          codeBlock(
            "Request example",
            JSON.stringify(request.example, null, 2),
          ),
        );
        section.append(details);
      }
      const success = operation.responses["200"];
      section.append(element("h3", "Successful response · 200"));
      const responseType = Object.keys(success.content)[0];
      const sample = success.content[responseType].example;
      if (sample)
        section.append(
          codeBlock("Illustrative response", JSON.stringify(sample, null, 2)),
        );
      else
        section.append(
          element(
            "p",
            "Binary audio. Save the response to speech.wav, or request response_format: pcm for raw mono 24 kHz, 16-bit audio.",
          ),
        );
      if (success.content["text/event-stream"]) {
        const details = element("details");
        details.append(
          element("summary", "Streaming responses"),
          element(
            "p",
            "Set stream: true and use curl -N. Watch for error events as well as a completed response. Usage may only appear in final events.",
          ),
        );
        if (success.content["text/event-stream"].example)
          details.append(
            codeBlock(
              "Illustrative SSE events",
              success.content["text/event-stream"].example,
            ),
          );
        section.append(details);
      }
    }
    byId("endpoint-reference").append(section);
  }
  byId("reference-status").hidden = true;
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView();
  }
}
render().catch(() => {
  const status = byId("reference-status");
  status.textContent =
    "The API contract could not be loaded. Reload this page, or use Download OpenAPI to inspect the JSON directly.";
});
