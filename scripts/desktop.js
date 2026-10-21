const { spawn } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [path.resolve(__dirname, ".."), ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
child.on("error", () => {
  console.error("Desktop runtime could not start. Run npm ci and try again.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
