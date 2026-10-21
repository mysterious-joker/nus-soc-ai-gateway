// Explicit download check for release engineering. No account or inference access.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createTools, VERSION } = require("../lib/tools");
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
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
