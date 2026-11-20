// Structured JSON logger. One line per event: {ts, level, component, msg, ...fields}.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  minLevel?: LogLevel; // defaults to LOG_LEVEL env or "info"
  sink?: (line: string) => void; // defaults to process.stdout.write
}

function envLevel(): LogLevel {
  const raw = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined) ?? "info";
  return raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

export function createLogger(component: string, opts: LoggerOptions = {}): Logger {
  const minLevel = opts.minLevel ?? envLevel();
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));

  function emit(level: LogLevel, msg: string, base: Record<string, unknown>, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...base,
      ...fields,
    };
    sink(JSON.stringify(entry));
  }

  function make(base: Record<string, unknown>): Logger {
    return {
      debug: (msg, fields) => emit("debug", msg, base, fields),
      info: (msg, fields) => emit("info", msg, base, fields),
      warn: (msg, fields) => emit("warn", msg, base, fields),
      error: (msg, fields) => emit("error", msg, base, fields),
      child: (extra) => make({ ...base, ...extra }),
    };
  }

  return make({});
}
