import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(homedir(), ".codex/plugins/.plugin-appserver/codex"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known first-party Codex binary.
    }
  }

  return "codex";
}
