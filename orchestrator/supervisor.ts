import { spawn, type ChildProcess } from "node:child_process";

export function supervise(commands: string[][]) {
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  };

  for (const [command, ...args] of commands) {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit",
    });
    children.push(child);
    child.on("error", (error) => {
      console.error(`${command} failed:`, error);
      stop();
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(
        `${command} exited unexpectedly (${code ?? signal ?? "unknown"})`,
      );
      stop();
      process.exitCode = code && code !== 0 ? code : 1;
    });
  }

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
