const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const equal = (a, b) =>
  crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
function privateWrite(file, content) {
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function secretFile(file) {
  if (!fs.existsSync(file)) privateWrite(file, random());
  fs.chmodSync(file, 0o600);
  return fs.readFileSync(file, "utf8").trim();
}
function domainAllowed(email, domain) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+$/.test(email) &&
    email.split("@")[1].toLowerCase() === domain
  );
}
function localRequest(req, port) {
  const hosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
  if (!hosts.has(req.headers.host))
    throw new HttpError(403, "Use the local gateway address.");
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`)
    throw new HttpError(403, "Cross-origin access is not allowed.");
  const publicNavigation =
    req.method === "GET" &&
    [
      "/",
      "/index.html",
      "/reference",
      "/reference.html",
      "/openapi.json",
    ].includes(req.url?.split("?")[0]) &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document";
  if (req.headers["sec-fetch-site"] === "cross-site" && !publicNavigation)
    throw new HttpError(403, "Cross-site access is not allowed.");
}
function headers(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );
}
async function readJson(req, limit = 2 * 1024 * 1024) {
  if (
    !(req.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Send Content-Type: application/json.");
  if (Number(req.headers["content-length"]) > limit)
    throw new HttpError(413, "Request body is too large.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!obj || Array.isArray(obj) || typeof obj !== "object")
      throw new Error();
    return obj;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}
function createSessions(dataDir) {
  // Independent dashboard credential: project API keys never grant administration.
  const password = secretFile(path.join(dataDir, "dashboard-token"));
  const sessions = new Map();
  let failures = [];
  const cookie = (token, age) =>
    `nus_gateway=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
  function get(req) {
    const id = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("nus_gateway="))
      ?.slice(12);
    const session = sessions.get(id);
    if (!session || session.expires < Date.now()) {
      sessions.delete(id);
      return null;
    }
    return { ...session, id };
  }
  return {
    login(token, res) {
      failures = failures.filter((t) => t > Date.now() - 60_000);
      if (failures.length >= 10)
        throw new HttpError(429, "Too many attempts. Try again in one minute.");
      if (typeof token !== "string" || !equal(token, password)) {
        failures.push(Date.now());
        throw new HttpError(
          401,
          "Invalid dashboard token. Run npm run open on this Mac.",
        );
      }
      const id = random();
      const csrf = random();
      for (const [key, session] of sessions)
        if (session.expires < Date.now()) sessions.delete(key);
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { csrf, expires: Date.now() + 8 * 3600_000 });
      res.setHeader("Set-Cookie", cookie(id, 8 * 3600));
      return { csrf };
    },
    require(req, mutate = false) {
      const session = get(req);
      if (!session)
        throw new HttpError(401, "Unlock the dashboard to continue.");
      if (mutate && !equal(req.headers["x-csrf-token"] || "", session.csrf))
        throw new HttpError(
          403,
          "Session verification failed. Reload the dashboard.",
        );
      return session;
    },
    logout(req, res) {
      const session = get(req);
      if (session) sessions.delete(session.id);
      res.setHeader("Set-Cookie", cookie("", 0));
    },
  };
}
module.exports = {
  HttpError,
  hash,
  random,
  equal,
  privateDir,
  privateWrite,
  secretFile,
  domainAllowed,
  localRequest,
  headers,
  readJson,
  createSessions,
};
