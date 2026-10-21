const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  HttpError,
  domainAllowed,
  privateDir,
  privateWrite,
} = require("./security");

function identityFromLog(text, expected) {
  const match = text.match(
    /applyAuthResult: email=([^,\s]+), authMethod=(\w+), quotaProject=([^\s]+)/,
  );
  if (
    !text.includes("authenticated via keyring (effective: gcp)") ||
    !match ||
    match[2] !== "gcp" ||
    !domainAllowed(match[1], "comp.nus.edu.sg")
  )
    throw new HttpError(
      403,
      "Sign in to Antigravity CLI with your @comp.nus.edu.sg school subscription account.",
    );
  const account = { email: match[1].toLowerCase(), project: match[3] };
  if (
    expected &&
    (expected.email !== account.email || expected.project !== account.project)
  )
    throw new HttpError(
      403,
      "The CLI account or school project changed. Reconnect Gemini in Sources.",
    );
  return account;
}
function parseModels(text) {
  const models = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]{0,249})\t(.+)$/);
    if (match)
      models.set(match[1], {
        id: `gemini/${match[1]}`,
        upstreamId: match[1],
        name: match[2].trim(),
        provider: "gemini",
        type: "llm",
        classification: "provider",
        contextWindow: null,
        multimodal: false,
      });
  }
  if (!models.size)
    throw new HttpError(
      502,
      "The CLI did not return a recognized model catalog.",
    );
  return [...models.values()];
}
function textContent(content) {
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.every(
      (p) =>
        p &&
        ["text", "input_text", "output_text"].includes(p.type) &&
        typeof p.text === "string",
    )
  )
    return content.map((p) => p.text).join("\n");
  throw new HttpError(400, "Gemini CLI currently supports text messages only.");
}
function conversation(body, endpoint) {
  if (!["/v1/chat/completions", "/v1/responses"].includes(endpoint))
    throw new HttpError(
      400,
      "Gemini CLI supports text Chat Completions and Responses only.",
    );
  const allowed = new Set([
    "model",
    "stream",
    "stream_options",
    ...(endpoint === "/v1/responses"
      ? ["input", "instructions"]
      : ["messages"]),
  ]);
  for (const key of Object.keys(body))
    if (!allowed.has(key))
      throw new HttpError(
        400,
        `Gemini CLI does not support the ${key} parameter.`,
      );
  let messages =
    endpoint === "/v1/responses"
      ? typeof body.input === "string"
        ? [{ role: "user", content: body.input }]
        : body.input
      : body.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 200)
    throw new HttpError(
      400,
      "Supply a nonempty text conversation (up to 200 messages).",
    );
  messages = messages.map((m) => {
    if (
      !m ||
      !["system", "developer", "user", "assistant"].includes(m.role) ||
      Object.keys(m).some((k) => !["role", "content", "type"].includes(k)) ||
      (m.type && m.type !== "message")
    )
      throw new HttpError(
        400,
        "Gemini CLI supports text conversation messages without tool calls.",
      );
    return { role: m.role, content: textContent(m.content) };
  });
  if (body.instructions !== undefined)
    messages.unshift({
      role: "system",
      content: textContent(body.instructions),
    });
  const prompt =
    "Answer the following conversation as the assistant. Return only the answer.\n" +
    JSON.stringify(messages);
  if (Buffer.byteLength(prompt) > 128 * 1024)
    throw new HttpError(413, "Gemini CLI text input exceeds 128 KiB.");
  return prompt;
}
function cliError(message = "") {
  if (/quota|resource.exhausted|429/i.test(message)) {
    const reset = message.match(/Resets in [\dhms .]+/i)?.[0];
    return new HttpError(
      429,
      `Gemini subscription quota is exhausted.${reset ? ` ${reset.trim()}` : " Check quota in Antigravity CLI."}`,
    );
  }
  if (/auth|sign.in|login/i.test(message))
    return new HttpError(
      401,
      "Sign in again using Antigravity CLI, then reconnect Gemini.",
    );
  return new HttpError(
    502,
    "Gemini CLI could not complete the request. Check the CLI session and retry.",
  );
}

function createGeminiCli({
  dataDir,
  store,
  binary = path.join(os.homedir(), ".local/bin/agy"),
  spawnProcess = spawn,
}) {
  const workspace = path.join(dataDir, "gemini-cli-workspace");
  const active = new Set();
  let busy = false;
  let revision = 0;
  function prepare() {
    privateDir(workspace);
    privateDir(path.join(workspace, ".agents"));
    privateDir(path.join(workspace, ".agents/agents"));
    privateWrite(
      path.join(workspace, ".agents/agents/gateway-chat.md"),
      `---
name: gateway-chat
description: Text-only assistant for the local gateway.
tools: [finish]
mainAgent: true
subagent: false
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
You are a text-only assistant. Answer the supplied conversation. Do not use tools, access files, execute commands, browse, or delegate. Return only the requested assistant response.
`,
    );
    // Explicit tool lists are not enforced by all CLI releases. Deny every tool at execution time.
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const hook = path.join(workspace, "deny-tools.cjs");
    privateWrite(
      hook,
      `const fs=require('node:fs');
if(process.argv[2]==='ready') fs.writeFileSync(process.env.NUS_GATEWAY_HOOK_READY,'ready',{mode:0o600});
else process.stdout.write(JSON.stringify({decision:'deny',reason:'Gateway tool execution is disabled. Respond in text only.'}));
`,
    );
    const command = `${quote(process.execPath)} ${quote(hook)}`;
    privateWrite(
      path.join(workspace, ".agents/hooks.json"),
      JSON.stringify({
        "gateway-deny-tools": {
          SessionStart: [
            { type: "command", command: `${command} ready`, timeout: 5 },
          ],
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] },
          ],
        },
      }),
    );
  }
  function environment(marker) {
    const env = {};
    for (const k of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG"])
      if (process.env[k]) env[k] = process.env[k];
    env.NUS_GATEWAY_HOOK_READY = marker;
    // Packaged desktop apps use Electron's bundled Node runtime for the deny hook.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    // No API key, ADC, endpoint override or proxy environment is inherited.
    const settingsPath = path.join(
      os.homedir(),
      ".gemini/antigravity-cli/settings.json",
    );
    const configPath = path.join(os.homedir(), ".gemini/config/config.json");
    const settings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
      : {};
    const config = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    if (settings.modelProvider || config.userSettings?.enableAdc)
      throw new HttpError(
        403,
        "Gemini requires the CLI subscription login. Disable API-key/ADC overrides in Antigravity first.",
      );
    return env;
  }
  async function run({ model, prompt, expected, signal, onText }) {
    if (process.platform === "win32")
      throw new HttpError(
        503,
        "Gemini CLI integration is available on macOS and Linux. Windows support is not yet enabled; use ChatGPT or SoCLaaS here.",
      );
    const executable = typeof binary === "function" ? binary() : binary;
    if (!executable)
      throw new HttpError(
        503,
        "Install Antigravity CLI, sign in with your school subscription, then reconnect in Sources.",
      );
    if (signal?.aborted) throw new HttpError(499, "Client disconnected.");
    const runRevision = revision;
    prepare();
    const id = crypto.randomUUID();
    const logFile = path.join(workspace, `${id}.log`);
    const marker = path.join(workspace, `${id}.ready`);
    privateWrite(logFile, "");
    const inference = prompt !== undefined;
    const args = [
      "--log-file",
      logFile,
      ...(inference
        ? [
            "--agent",
            "gateway-chat",
            "--model",
            model,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--disable-slash-commands",
            "--sandbox",
            "--print-timeout",
            "110s",
          ]
        : ["models"]),
    ];
    try {
      const env = environment(marker);
      return await new Promise((resolve, reject) => {
        const child = spawnProcess(executable, args, {
          cwd: workspace,
          env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        active.add(child);
        let output = "",
          buffer = "",
          bytes = 0,
          result,
          identity,
          failure,
          initialized = false;
        const kill = () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const fail = (e) => {
          failure ||= e;
          kill();
        };
        const aborted = () => fail(new HttpError(499, "Client disconnected."));
        const timer = setTimeout(
          () => fail(new HttpError(504, "Gemini CLI request timed out.")),
          inference ? 120_000 : 30_000,
        );
        signal?.addEventListener("abort", aborted, { once: true });
        child.stdin.on("error", () => {});
        child.stdout.setEncoding("utf8");
        child.stderr.on("data", () => {}); // Never relay diagnostics or credential material to API callers.
        child.on("error", () =>
          fail(
            new HttpError(
              503,
              "Antigravity CLI could not start. Install and sign in to agy, then reconnect in Sources.",
            ),
          ),
        );
        child.stdout.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8 * 1024 * 1024)
            return fail(
              new HttpError(
                502,
                "Gemini CLI output exceeded the supported size.",
              ),
            );
          if (!inference) {
            output += chunk;
            return;
          }
          buffer += chunk.toString("utf8");
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim() || failure) continue;
            try {
              const event = JSON.parse(line);
              if (event.event === "init") {
                if (
                  initialized ||
                  event.init?.agent !== "gateway-chat" ||
                  event.init?.model !== model ||
                  event.init?.permission_mode !== "request-review"
                )
                  throw new HttpError(
                    502,
                    "Unexpected Gemini CLI session configuration.",
                  );
                const startupLog = fs.readFileSync(logFile, "utf8");
                identity = identityFromLog(startupLog, expected);
                if (
                  !/loaded [1-9]\d* named hooks from [1-9]\d* hooks\.json file/.test(
                    startupLog,
                  )
                )
                  throw new HttpError(
                    503,
                    "Gemini tool restrictions were not loaded. Request blocked.",
                  );
                if (runRevision !== revision)
                  throw new HttpError(403, "Gemini was disconnected.");
                initialized = true;
                child.stdin.end(
                  JSON.stringify({
                    event: "user",
                    message: { content: prompt },
                  }) + "\n",
                );
              } else if (
                event.event === "step_update" &&
                event.step_update?.step_type === "agent_response" &&
                initialized
              ) {
                if (!fs.existsSync(marker))
                  throw new HttpError(
                    503,
                    "Gemini tool restrictions were not activated. Request blocked.",
                  );
                if (typeof event.step_update.text_delta === "string")
                  onText?.(event.step_update.text_delta);
              } else if (event.event === "result") result = event.result;
            } catch (e) {
              fail(
                e.status
                  ? e
                  : new HttpError(502, "Unrecognized Gemini CLI response."),
              );
            }
          }
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          active.delete(child);
          if (runRevision !== revision)
            failure ||= new HttpError(403, "Gemini was disconnected.");
          if (failure) return reject(failure);
          try {
            if (!inference) {
              if (code !== 0) throw cliError();
              return resolve({
                account: identityFromLog(
                  fs.readFileSync(logFile, "utf8"),
                  expected,
                ),
                models: parseModels(output),
              });
            }
            if (
              code !== 0 ||
              !initialized ||
              result?.status !== "SUCCESS" ||
              typeof result.response !== "string"
            )
              throw cliError(result?.error);
            if (!fs.existsSync(marker))
              throw new HttpError(
                503,
                "Gemini tool restrictions were not activated. Request blocked.",
              );
            resolve({ ...result, account: identity });
          } catch (e) {
            reject(e);
          }
        });
        if (!inference) child.stdin.end();
      });
    } finally {
      for (const f of [logFile, marker]) fs.rmSync(f, { force: true });
    }
  }
  return {
    enabled: () => Boolean(store.get("gemini_cli_connection")),
    async connect({ signal } = {}) {
      const result = await run({ signal });
      if (signal?.aborted)
        throw new HttpError(499, "Gemini setup was cancelled.");
      store.set("gemini_cli_connection", result.account);
      return result;
    },
    prepareLogin(directory) {
      prepare();
      const executable = typeof binary === "function" ? binary() : binary;
      if (!executable)
        throw new HttpError(503, "Gemini connection tool is missing.");
      const logFile = path.join(directory, "login.log");
      privateWrite(logFile, "");
      const env = environment(path.join(directory, "ready"));
      // Interactive Google sign-in needs the desktop session to open a browser
      // on Linux. These variables do not select provider credentials/endpoints.
      for (const key of [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_CURRENT_DESKTOP",
      ])
        if (process.env[key]) env[key] = process.env[key];
      return {
        executable,
        cwd: workspace,
        env,
        args: ["--agent", "gateway-chat", "--sandbox", "--log-file", logFile],
        logFile,
      };
    },
    disconnect() {
      revision++;
      store.set("gemini_cli_connection", null);
      for (const child of active) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    },
    discover() {
      return run({ expected: store.get("gemini_cli_connection") });
    },
    async generate({ model, body, endpoint, signal, onText }) {
      const expected = store.get("gemini_cli_connection");
      if (!expected)
        throw new HttpError(403, "Connect Gemini in Sources first.");
      const prompt = conversation(body, endpoint);
      if (busy)
        throw new HttpError(
          429,
          "Gemini CLI is serving another request. Retry shortly.",
        );
      busy = true;
      try {
        return await run({ model, prompt, expected, signal, onText });
      } finally {
        busy = false;
      }
    },
    stop() {
      for (const child of active) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    },
  };
}
module.exports = {
  createGeminiCli,
  identityFromLog,
  parseModels,
  conversation,
};
