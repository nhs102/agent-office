import { spawn } from "node:child_process";
import { resolveCodexBinary } from "./codex-binary";

const child = spawn(resolveCodexBinary(), process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
