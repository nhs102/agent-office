import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, ProjectDefinition } from "./types";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

async function readJson<T>(relativePath: string): Promise<T> {
  const contents = await readFile(path.join(projectRoot, relativePath), "utf8");
  return JSON.parse(contents) as T;
}

export async function loadConfiguration() {
  const [agents, projects] = await Promise.all([
    readJson<AgentDefinition[]>("config/agents.json"),
    readJson<ProjectDefinition[]>("config/projects.json"),
  ]);

  return {
    agents: agents.map((agent) => ({
      ...agent,
      cwd: path.resolve(projectRoot, agent.cwd),
    })),
    projects: projects.map((project) => ({
      ...project,
      cwd: path.resolve(projectRoot, project.cwd),
    })),
  };
}
