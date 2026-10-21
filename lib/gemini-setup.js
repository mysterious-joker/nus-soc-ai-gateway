const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const {
  HttpError,
  privateDir,
  privateWrite,
  domainAllowed,
} = require("./security");

const execute = promisify(execFile);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const ACTIVE = new Set(["preparing", "checking", "waiting", "verifying"]);

async function openTerminal(script, platform = process.platform) {
  if (platform === "darwin") {
    await execute("/usr/bin/open", ["-a", "Terminal", script], {
      timeout: 10_000,
    });
    return;
  }
  if (platform === "linux") {
    for (const [command, args] of [
      ["x-terminal-emulator", ["-e", script]],
      ["gnome-terminal", ["--", script]],
      ["konsole", ["--separate", "-e", script]],
      ["xterm", ["-e", script]],
    ]) {
      // Some terminals stay alive until their window closes. A timeout means
      // launch succeeded; don't open a second window or kill the terminal.
      const launched = await new Promise((resolve) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        let timer;
        child.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
        timer = setTimeout(() => {
          child.unref();
          resolve(true);
        }, 500);
      });
      if (launched) return;
    }
  }
  throw new HttpError(
    503,
    "A desktop terminal could not be opened. Install a terminal, or sign in with agy manually and retry Connect Gemini.",
  );
}

function loginScript(context, doneFile) {
  const env = Object.entries(context.env).map(([key, value]) =>
    quote(`${key}=${value}`),
  );
  return `#!/bin/sh\numask 077\ntrap ${quote(`test ! -d ${quote(path.dirname(doneFile))} || touch ${quote(doneFile)}`)} 0\ncd ${quote(context.cwd)} || exit 1\nprintf '%s\\n' 'NUS SoC AI Gateway: sign in with your @comp.nus.edu.sg account and select your school subscription.' 'Complete the CLI setup prompts. The dashboard connects automatically; you can then close this window.'\n/usr/bin/env -i TERM="\${TERM:-xterm-256color}" ${env.join(" ")} ${[context.executable, ...context.args].map(quote).join(" ")}\n`;
}

function createGeminiSetup({
  dataDir,
  tools,
  gemini,
  onConnected,
  launch = openTerminal,
  timeoutMs = 10 * 60_000,
  pollMs = 1000,
}) {
  let state = { status: "idle", message: "" };
  let controller;
  let task;
  const snapshot = () => ({ ...state });
  const running = () => ACTIVE.has(state.status);
  const update = (status, message) => {
    state = { status, message };
  };

  async function run(signal) {
    let directory;
    try {
      await tools.installGemini({ signal });
      signal.throwIfAborted();
      update("checking", "Checking your saved school login…");
      try {
        await gemini.connect({ signal });
      } catch (error) {
        signal.throwIfAborted();
        if (![401, 403, 502, 504].includes(error.status)) throw error;
        privateDir(dataDir);
        directory = fs.mkdtempSync(path.join(dataDir, ".gemini-login-"));
        fs.chmodSync(directory, 0o700);
        const context = gemini.prepareLogin(directory);
        const doneFile = path.join(directory, "done");
        const script = path.join(directory, "Sign in to Gemini.command");
        privateWrite(script, loginScript(context, doneFile));
        fs.chmodSync(script, 0o700);
        await launch(script);
        signal.throwIfAborted();
        update(
          "waiting",
          "Finish Google sign-in in the terminal window using @comp.nus.edu.sg, then select your school subscription. Complete any first-run prompts. This page connects automatically.",
        );
        const deadline = Date.now() + timeoutMs;
        while (true) {
          await delay(pollMs, undefined, { signal });
          if (Date.now() > deadline)
            throw new HttpError(
              408,
              "Gemini setup timed out. Close the sign-in window and try Connect Gemini again.",
            );
          if (fs.statSync(context.logFile).size > 1024 * 1024)
            throw new HttpError(
              502,
              "Gemini sign-in produced too much diagnostic output. Close the window and retry.",
            );
          const log = fs.readFileSync(context.logFile, "utf8");
          const identity = log.match(
            /applyAuthResult: email=([^,\s]+), authMethod=(\w+), quotaProject=([^\s]+)/,
          );
          if (
            identity &&
            (!domainAllowed(identity[1], "comp.nus.edu.sg") ||
              identity[2] !== "gcp")
          )
            throw new HttpError(
              403,
              "The CLI is using a different account or authentication method. Use /logout in that window, sign in with @comp.nus.edu.sg and your school subscription, then retry Connect Gemini.",
            );
          if (identity || fs.existsSync(doneFile)) break;
        }
        update(
          "verifying",
          "Verifying your school session and fetching its model catalog…",
        );
        await gemini.connect({ signal });
      }
      signal.throwIfAborted();
      await onConnected();
      signal.throwIfAborted();
      update(
        "connected",
        directory
          ? "Gemini connected. You can close the sign-in terminal window."
          : "Gemini connected using your saved school login.",
      );
    } catch (error) {
      if (!signal.aborted)
        update(
          "error",
          error.status
            ? error.message
            : "Gemini setup could not finish. Close the sign-in window and retry.",
        );
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return {
    snapshot,
    running,
    start() {
      if (task || running())
        throw new HttpError(
          409,
          "Gemini setup is already running. Finish or cancel it first.",
        );
      if (!tools.status().gemini.supported)
        throw new HttpError(
          400,
          "Gemini CLI integration is available on macOS and Linux only.",
        );
      controller = new AbortController();
      update(
        "preparing",
        "Preparing Gemini securely. The first download may take a minute…",
      );
      task = run(controller.signal).finally(() => {
        task = null;
      });
      return snapshot();
    },
    async cancel() {
      if (task) {
        controller.abort();
        update(
          "cancelled",
          "Setup cancelled. Close any Gemini sign-in window. Your Google account has not been signed out.",
        );
        await task;
      }
      return snapshot();
    },
    reset() {
      if (task)
        throw new HttpError(409, "Cancel Gemini setup before resetting it.");
      update("idle", "");
    },
  };
}
module.exports = { createGeminiSetup, loginScript, openTerminal };
