// Explicit download check for release engineering. No account or inference access.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { createTools, VERSION } = require("../lib/tools");
const {
  installGeminiTool,
  toolDirectory,
  VERSION: GEMINI_VERSION,
} = require("../lib/gemini-tool");
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-tool-check-"));
  try {
    const tools = createTools({ dataDir, env: {} });
    await tools.installBridge();
    const executable = tools.resolve("cliproxyapi");
    if (executable?.source !== "managed")
      throw new Error("Managed tool was not selected.");
    const output = execFileSync(executable.path, ["-h"], {
      timeout: 10_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!output.includes(`Version: ${VERSION}`))
      throw new Error("Installed executable reported an unexpected version.");
    console.log(
      `Verified CLIProxyAPI ${VERSION}: archive digest, extraction and executable startup (${process.platform}/${process.arch}).`,
    );
    if (process.platform !== "win32") {
      await installGeminiTool({
        dataDir,
        platform: process.platform,
        arch: process.arch,
      });
      const result = spawnSync(
        path.join(
          toolDirectory(dataDir, process.platform, process.arch),
          "agy",
        ),
        ["--help"],
        {
          timeout: 10_000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (
        result.error ||
        result.status !== 0 ||
        !(result.stdout + result.stderr).includes("models")
      )
        throw new Error("Gemini CLI did not return its command help.");
      console.log(
        `Verified Antigravity CLI ${GEMINI_VERSION}: archive digest, extraction and startup (${process.platform}/${process.arch}).`,
      );
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
