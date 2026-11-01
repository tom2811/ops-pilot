import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(currentDir, "server.ts");
const workerScript = resolve(currentDir, "worker.ts");

console.log("[start-all] Starting OpsPilot API and Worker processes...");

const serverProcess = spawn("tsx", [serverScript], {
  stdio: "inherit",
  env: process.env,
});

const workerProcess = spawn("tsx", [workerScript], {
  stdio: "inherit",
  env: process.env,
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[start-all] Received ${signal}, terminating child processes...`);
  serverProcess.kill(signal);
  workerProcess.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

serverProcess.on("exit", (code, signal) => {
  console.log(`[start-all] Server process exited with code ${code}, signal ${signal}`);
  shutdown("SIGTERM");
  process.exit(code ?? 0);
});

workerProcess.on("exit", (code, signal) => {
  console.log(`[start-all] Worker process exited with code ${code}, signal ${signal}`);
});
