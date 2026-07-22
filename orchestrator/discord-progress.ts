const verificationCommands = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|check)\b/i,
  /\b(?:pytest|vitest|jest|eslint|tsc)\b/i,
  /\bnext\s+build\b/i,
];

export function isDiscordVerificationCommand(command: unknown) {
  if (typeof command !== "string") return false;
  return verificationCommands.some((pattern) => pattern.test(command));
}

export function normalizeDiscordProgressText(text: unknown, limit = 1_500) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<office_(?:summary|details)>/gi, "")
    .replace(/<\/office_(?:summary|details)>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}
