/**
 * Lightweight logger that matches the createSubsystemLogger interface
 * used by the policy feedback engine files. In the plugin context, we
 * just prefix console output with the subsystem name.
 */
export function createSubsystemLogger(name: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => {
      if (process.env.OPENCLAW_VERBOSE === "1") {
        console.debug(`[${name}]`, msg, meta ?? "");
      }
    },
    info: (msg: string, meta?: Record<string, unknown>) => {
      console.info(`[${name}]`, msg, meta ?? "");
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      console.warn(`[${name}]`, msg, meta ?? "");
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      console.error(`[${name}]`, msg, meta ?? "");
    },
  };
}
