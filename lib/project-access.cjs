"use strict";

const path = require("node:path");

function projectPath(project) {
  return project?.projectPath ?? project?.path ?? "";
}

function pathKey(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const clean = value.trim();
  return /^[a-z]:[\\/]/i.test(clean)
    ? path.win32.normalize(clean).replace(/[\\/]+$/, "").toLowerCase()
    : path.posix.normalize(clean).replace(/\/+$/, "");
}

function isProjectAllowed(policy, value) {
  return policy.mode === "all" || Boolean(pathKey(value) && policy.paths.some(item => pathKey(item) === pathKey(value)));
}

async function listProjects(invoke) {
  const result = await invoke("project/list", []);
  const projects = Array.isArray(result) ? result : result?.projects;
  if (!Array.isArray(projects)) throw new Error("宿主未返回项目列表");
  return projects.filter(project => projectPath(project)).map(project => ({
    path: projectPath(project),
    name: project.name || project.title || projectPath(project),
  }));
}

module.exports = { projectPath, pathKey, isProjectAllowed, listProjects };
