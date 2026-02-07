export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): number {
  const env = (process.env["LOG_LEVEL"] ?? "info").toLowerCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.info;
}

function log(level: LogLevel, component: string, msg: string, data?: object): void {
  if (LEVELS[level] < getMinLevel()) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...data,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(entry));
}

export interface Logger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, data) => log("debug", component, msg, data),
    info: (msg, data) => log("info", component, msg, data),
    warn: (msg, data) => log("warn", component, msg, data),
    error: (msg, data) => log("error", component, msg, data),
  };
}
