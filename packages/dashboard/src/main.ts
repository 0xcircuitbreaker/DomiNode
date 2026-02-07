import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool } from "@dominode/shared";
import { startApiServer } from "./server.js";

const log = createLogger("api:main");
const port = parseInt(process.env["DASHBOARD_PORT"] ?? "3000", 10);

const server = startApiServer(port);

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down...`);
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
