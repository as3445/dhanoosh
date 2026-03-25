/**
 * Shim for openclaw's internal hook system.
 *
 * In the plugin context, hooks are registered via the plugin API (api.on()),
 * not via internal hooks. This shim exists so hooks.ts compiles, but the
 * plugin entry point bypasses it entirely, wiring events directly through
 * the plugin API callbacks.
 */

export type InternalHookEvent = {
  type: string;
  sessionKey: string;
  context: Record<string, unknown>;
};

export function isMessageReceivedEvent(event: InternalHookEvent): boolean {
  return event.type === "message:received";
}

export function isMessageSentEvent(event: InternalHookEvent): boolean {
  return event.type === "message:sent";
}

// No-ops — the plugin API handles registration instead.
export function registerInternalHook(_name: string, _handler: unknown): void {}
export function unregisterInternalHook(_name: string, _handler: unknown): void {}
