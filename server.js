const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  HttpError,
  headers,
  readJson,
  localRequest,
  createSessions,
} = require("./lib/security");
const { createStore } = require("./lib/store");
const { createBridge } = require("./lib/bridge");
const { createCatalog } = require("./lib/catalog");
const { discover } = require("./lib/providers");
const { proxy } = require("./lib/proxy");
const { createGeminiCli } = require("./lib/gemini-cli");
const { ENDPOINTS } = require("./lib/capabilities");
const { readBody } = require("./lib/media");
const {
  discoverRealtime,
  speech,
  wav,
  createRealtimeRelay,
} = require("./lib/realtime");
function createGateway(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 4000);
  const dataDir =
    options.dataDir ||
    process.env.GATEWAY_DATA_DIR ||
    path.join(__dirname, "data");
  const store = options.store || createStore(dataDir);
  const sessions = createSessions(dataDir);
  const gemini =
    options.gemini ||
    createGeminiCli({ dataDir, store, binary: process.env.AGY_BIN });
  let catalog;
  const bridge =
    options.bridge ||
    createBridge({
      dataDir,
      port: Number(process.env.CPA_PORT || 8317),
      store,
      binary:
        process.env.CPA_BIN ||
        (fs.existsSync("/opt/homebrew/bin/cliproxyapi")
          ? "/opt/homebrew/bin/cliproxyapi"
          : "cliproxyapi"),
      onChange: () => {
        catalog.invalidate();
        catalog.refresh(true).catch(() => {});
      },
    });
  catalog =
    options.catalog ||
    createCatalog({
      bridge,
      store,
      gemini,
      fetcher: options.fetcher,
      discoverRealtime:
        options.discoverRealtime ||
        (!options.bridge ? () => discoverRealtime(bridge) : undefined),
    });
  const realtime = createRealtimeRelay({ bridge, catalog, store });
  const json = (res, status, payload) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(payload));
  };
  const staticFiles = {
    "/": ["index.html", "text/html"],
    "/index.html": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/styles.css": ["styles.css", "text/css"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  };
  let activeRequests = 0;
  let initialized = false;
  let timer;
  async function audioSpeech(req, res, body, key, allowUnverified = false) {
    const endpoint = "/v1/audio/speech";
    if (
      Object.keys(body).some(
        (k) =>
          !["model", "input", "voice", "response_format", "stream"].includes(k),
      ) ||
      body.stream === true
    )
      throw new HttpError(
        400,
        "Speech supports model, input, voice and response_format (wav or pcm). Use /v1/realtime for streaming.",
      );
    if (body.response_format && !["wav", "pcm"].includes(body.response_format))
      throw new HttpError(400, "Choose wav or pcm speech output.");
    if (
      typeof body.input !== "string" ||
      !body.input.trim() ||
      body.input.length > 4000
    )
      throw new HttpError(400, "Speech input must contain 1–4000 characters.");
    if (
      body.voice !== undefined &&
      (typeof body.voice !== "string" ||
        !/^[a-zA-Z0-9_-]{1,50}$/.test(body.voice))
    )
      throw new HttpError(400, "Invalid voice.");
    const model = await catalog.resolve(body.model, {
      endpoint,
      allowUnverified,
    });
    if (model.type !== "realtime-audio")
      throw new HttpError(400, "Choose a realtime audio model.");
    await catalog.assertIncluded(model);
    const controller = new AbortController();
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
      stream: false,
    };
    try {
      const pcm = await speech({
        bridge,
        model,
        input: body.input,
        voice: body.voice,
        signal: controller.signal,
        onUsage: (usage) => {
          log.usage = usage;
        },
      });
      log.status = 200;
      catalog.observeResult(model, "/v1/realtime", 200, true);
      res.writeHead(200, {
        "Content-Type":
          body.response_format === "pcm" ? "audio/pcm" : "audio/wav",
        "X-Gateway-Model": model.id,
      });
      res.end(body.response_format === "pcm" ? pcm : wav(pcm));
    } catch (error) {
      log.status = error.status || 502;
      throw error;
    } finally {
      res.removeListener("close", disconnect);
      store.record(log);
      catalog.observeResult(model, endpoint, log.status, log.status === 200);
    }
  }
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const currentPort = server.address()?.port || port;
      localRequest(req, currentPort);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;
      const method = req.method;
      if (route === "/api/session" && method === "POST") {
        const body = await readJson(req, 4096);
        return json(res, 200, sessions.login(body.token, res));
      }
      if (route === "/api/session" && method === "GET")
        return json(res, 200, { csrf: sessions.require(req).csrf });
      if (route.startsWith("/api/")) {
        sessions.require(req, !["GET", "HEAD"].includes(method));
        if (route === "/api/session" && method === "DELETE") {
          sessions.logout(req, res);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/dashboard" && method === "GET")
          return json(res, 200, {
            name: "NUS SoC AI Gateway",
            baseUrl: `http://localhost:${currentPort}/v1`,
            initialized,
            bridge: bridge.status,
            notices: bridge.notices,
            refreshing: catalog.refreshing,
            sources: catalog.sources(),
            models: catalog.list(),
            analytics: store.analytics(
              url.searchParams.get("timeframe") || "all",
            ),
            lifetime: store.analytics("all"),
            keys: store.keys(),
            flows: bridge.flows(),
          });
        if (!initialized && !options.ready)
          throw new HttpError(
            503,
            "Gateway is verifying saved accounts. Try again shortly.",
          );
        if (route === "/api/refresh" && method === "POST") {
          await catalog.refresh(true);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/oauth/start" && method === "POST") {
          const body = await readJson(req, 4096);
          return json(
            res,
            200,
            await bridge.startLogin(body.provider, body.mode || "browser"),
          );
        }
        if (route === "/api/oauth/cancel" && method === "POST") {
          const body = await readJson(req, 4096);
          bridge.cancel(body.provider);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/oauth/account" && method === "DELETE") {
          bridge.remove(url.searchParams.get("id"));
          return json(res, 200, { ok: true });
        }
        if (route === "/api/providers/soclaas" && method === "POST") {
          const body = await readJson(req, 16384);
          if (
            typeof body.apiKey !== "string" ||
            !body.apiKey.trim() ||
            body.apiKey.length > 8192 ||
            /[\r\n]/.test(body.apiKey)
          )
            throw new HttpError(400, "Enter a valid SoCLaaS API key.");
          const key = body.apiKey.trim();
          await discover("soclaas", { apiKey: key }, options.fetcher);
          store.setSoclaasKey(key);
          catalog.invalidate();
          await catalog.refresh(true);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/providers/gemini/cli" && method === "POST") {
          await gemini.connect();
          catalog.invalidate();
          await catalog.refresh(true);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/providers/gemini/cli" && method === "DELETE") {
          gemini.disconnect();
          catalog.invalidate();
          await catalog.refresh(true);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/providers/soclaas" && method === "DELETE") {
          store.setSoclaasKey("");
          catalog.invalidate();
          await catalog.refresh(true);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/keys" && method === "POST") {
          const body = await readJson(req, 4096);
          return json(res, 201, store.createKey(body.name));
        }
        if (route === "/api/keys" && method === "DELETE") {
          store.revokeKey(url.searchParams.get("id") || "");
          return json(res, 200, { ok: true });
        }
        if (
          ["/api/playground", "/api/verify"].includes(route) &&
          method === "POST"
        ) {
          if (activeRequests >= 16)
            throw new HttpError(429, "Gateway is busy. Try again shortly.");
          activeRequests++;
          try {
            const requestedEndpoint =
              url.searchParams.get("endpoint") || "/v1/chat/completions";
            if (!ENDPOINTS.includes(requestedEndpoint))
              throw new HttpError(400, "Unsupported playground endpoint.");
            const { body, form } = await readBody(req, requestedEndpoint);
            const endpoint = body.endpoint || requestedEndpoint;
            if (!ENDPOINTS.includes(endpoint))
              throw new HttpError(400, "Unsupported playground endpoint.");
            delete body.endpoint;
            body.stream = false;
            if (form) {
              form.delete("endpoint");
              form.set("stream", "false");
            }
            if (endpoint === "/v1/audio/speech")
              return await audioSpeech(
                req,
                res,
                body,
                null,
                route === "/api/verify",
              );
            if (endpoint === "/v1/realtime")
              throw new HttpError(
                400,
                "Use a WebSocket connection for realtime audio.",
              );
            return await proxy({
              req,
              res,
              body,
              form,
              endpoint,
              key: null,
              catalog,
              bridge,
              store,
              fetcher: options.fetcher,
              gemini,
              // This route is behind dashboard authentication and CSRF validation.
              // Inference API keys and caller-supplied JSON cannot bypass verification.
              allowUnverified: route === "/api/verify",
            });
          } finally {
            activeRequests--;
          }
        }
        throw new HttpError(404, "API route not found.");
      }
      if (route.startsWith("/v1/")) {
        const key = store.authenticate(req);
        if (route === "/v1/models" && method === "GET") {
          await catalog.refresh();
          return json(res, 200, {
            object: "list",
            data: catalog
              .list()
              .filter((m) => m.available)
              .map((m) => ({
                id: m.id,
                object: "model",
                owned_by: m.provider,
                type: m.type,
                context_window: m.contextWindow,
                endpoints: m.endpoints,
                discovery: m.discovery,
                verification: m.verification,
              })),
          });
        }
        if (ENDPOINTS.includes(route) && method === "POST") {
          if (activeRequests >= 16)
            throw new HttpError(429, "Gateway is busy. Try again shortly.");
          activeRequests++;
          try {
            const { body, form } = await readBody(req, route);
            if (route === "/v1/audio/speech")
              return await audioSpeech(req, res, body, key);
            if (route === "/v1/realtime")
              throw new HttpError(
                400,
                "Use a WebSocket connection for realtime audio.",
              );
            return await proxy({
              req,
              res,
              body,
              form,
              endpoint: route,
              key,
              catalog,
              bridge,
              store,
              fetcher: options.fetcher,
              gemini,
            });
          } finally {
            activeRequests--;
          }
        }
        throw new HttpError(
          404,
          "This API endpoint is not supported by the gateway.",
        );
      }
      if (staticFiles[route] && method === "GET") {
        const [file, type] = staticFiles[route];
        res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(__dirname, "public", file)));
      }
      throw new HttpError(404, "Route not found.");
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, error.status || 500, {
          error: {
            message: error.status
              ? error.message
              : "An unexpected gateway error occurred. Try again.",
            type:
              error.status === 401 ? "authentication_error" : "gateway_error",
          },
        });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.on("upgrade", async (req, socket, head) => {
    let counted = false;
    try {
      localRequest(req, server.address()?.port || port);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/v1/realtime")
        throw new HttpError(404, "Unknown WebSocket endpoint.");
      const key = store.authenticate(req);
      if (activeRequests >= 16) throw new HttpError(429, "Gateway is busy.");
      activeRequests++;
      counted = true;
      socket.once("close", () => {
        if (counted) {
          counted = false;
          activeRequests--;
        }
      });
      const model = await catalog.resolve(url.searchParams.get("model"), {
        endpoint: "/v1/realtime",
      });
      if (model.provider !== "chatgpt" || model.type !== "realtime-audio")
        throw new HttpError(400, "Choose a realtime audio model.");
      await catalog.assertIncluded(model);
      await realtime.upgrade(req, socket, head, model, key);
    } catch (error) {
      if (counted) {
        activeRequests--;
        counted = false;
      }
      if (!socket.destroyed) {
        const body = JSON.stringify({
          error: {
            message: error.status
              ? error.message
              : "Realtime connection failed.",
          },
        });
        socket.end(
          `HTTP/1.1 ${error.status || 502} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      }
    }
  });
  return {
    server,
    store,
    bridge,
    catalog,
    gemini,
    dataDir,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await bridge.initialize();
      bridge.start();
      initialized = true;
      catalog.refresh(true).catch(() => {});
      timer = setInterval(() => catalog.refresh().catch(() => {}), 5 * 60_000);
      timer.unref();
      return server.address();
    },
    async stop() {
      clearInterval(timer);
      realtime.stop();
      bridge.stop();
      gemini.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      store.db.close();
    },
  };
}
if (require.main === module) {
  process.umask(0o077);
  const gateway = createGateway();
  gateway
    .start()
    .then((address) =>
      console.log(
        `NUS SoC AI Gateway is running at http://localhost:${address.port}\nRun npm run open to unlock the dashboard on this Mac.`,
      ),
    )
    .catch(() => {
      console.error(
        "Gateway could not start. Check that ports 4000 and 8317 are free and the data directory is writable.",
      );
      process.exitCode = 1;
      gateway.stop().catch(() => {});
    });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      gateway.stop().finally(() => process.exit(0));
    });
}
module.exports = { createGateway };
