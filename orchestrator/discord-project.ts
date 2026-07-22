export type DiscordProjectStatus = "working" | "complete" | "failed";

export function discordProjectTagNames(status: DiscordProjectStatus) {
  if (status === "working") {
    return ["in progress", "working", "active", "진행 중"];
  }
  if (status === "complete") {
    return ["completed", "complete", "done", "완료"];
  }
  return ["paused", "failed", "failure", "중단", "실패"];
}

export function discordProjectThreadName(
  title: string,
  status: DiscordProjectStatus = "working",
) {
  const icon = status === "working" ? "🚀" : status === "complete" ? "✅" : "⚠️";
  const clean = title
    .replace(/^[🚀✅⚠️]\s*/u, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled Project";
  return `${icon} ${clean}`.slice(0, 100);
}
