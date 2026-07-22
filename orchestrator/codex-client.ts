/* The app-server protocol is versioned and validated at the JSON-RPC boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { resolveCodexBinary } from "./codex-binary";
import type { RpcEnvelope } from "./types";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<number | string, PendingRequest>();
  private started = false;
  public initializeResult: any = null;

  get connected() {
    return this.started && this.process !== null && !this.process.killed;
  }

  async start() {
    if (this.process) return;

    const child = spawn(resolveCodexBinary(), ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit("stderr", text);
    });
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) => {
      this.handleExit(
        new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("codex app-server did not start in time")),
        10_000,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
    });

    this.initializeResult = await this.request("initialize", {
      clientInfo: {
        name: "codex_agent_office",
        title: "Codex Agent Office",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    });
    this.notify("initialized", {});
    this.started = true;
    this.emit("connected", this.initializeResult);
  }

  async stop() {
    this.started = false;
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request<T = any>(method: string, params: any): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      if (!this.process || this.process.stdin.destroyed) {
        reject(new Error("Codex app-server is not running"));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);

      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: any) {
    this.write({ method, params });
  }

  respond(id: number | string, result: any) {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  private write(message: RpcEnvelope) {
    if (!this.process || this.process.stdin.destroyed) {
      throw new Error("Codex app-server is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    let message: RpcEnvelope;
    try {
      message = JSON.parse(line) as RpcEnvelope;
    } catch {
      this.emit("protocolError", new Error(`Invalid JSON from Codex: ${line}`));
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `${pending.method}: ${message.error.message} (${message.error.code})`,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("protocolError", new Error(`Unknown Codex message: ${line}`));
  }

  private handleExit(error: Error) {
    if (!this.process && !this.started) return;
    this.process = null;
    this.started = false;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }
}
