/**
 * OpenClaw Plugin: Dhanoosh
 *
 * Adaptive policy layer that observes agent actions and user outcomes,
 * computes effectiveness statistics, and provides scoring/ranking guidance.
 *
 * Modes:
 *   off     — disabled entirely
 *   passive — observe and log only (default)
 *   advisory — inject policy hints into system prompt
 *   active  — suppress replies when policy recommends it
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { featureFlagsForMode } from "./config.js";
import { createPolicyFeedbackEngine, type PolicyFeedbackEngineImpl } from "./engine.js";
import {
  clearPolicyFeedbackEngine,
  getPolicyHintsForPrompt,
  getPolicyHintsSafe,
  isPolicyFeedbackActive,
  logPolicyAction,
  setPolicyFeedbackEngine,
} from "./gateway-bridge.js";
import { pruneOldRecords } from "./persistence.js";
import type { PolicyMode } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory state for correlating received → sent → outcome
// ---------------------------------------------------------------------------

// Correlation key: use conversationId (chat ID) since PluginHookMessageContext
// does not include sessionKey. conversationId is always populated and uniquely
// identifies a conversation across both message_received and message_sent hooks.

type PendingAction = {
  correlationKey: string;
  channelId: string;
  from: string;
  receivedAt: number;
  accountId?: string;
};

type ConfirmedAction = {
  actionId: string;
  correlationKey: string;
  channelId: string;
  sentAt: number;
  correlated: boolean;
};

const pendingActions = new Map<string, PendingAction>();
const recentConfirmedActions = new Map<string, ConfirmedAction[]>();

const MAX_CONFIRMED_PER_SESSION = 20;
const MAX_CORRELATION_AGE_MS = 86_400_000; // 24h
const MAX_PENDING_AGE_MS = 300_000; // 5m
const MAX_TOTAL_PENDING = 1000;

function pruneStalePendingActions(): void {
  try {
    const now = Date.now();
    for (const [key, entry] of pendingActions) {
      if (now - entry.receivedAt > MAX_PENDING_AGE_MS) {
        pendingActions.delete(key);
      }
    }
    if (pendingActions.size > MAX_TOTAL_PENDING) {
      const sorted = [...pendingActions.entries()].toSorted(
        (a, b) => a[1].receivedAt - b[1].receivedAt,
      );
      const toRemove = sorted.length - MAX_TOTAL_PENDING;
      for (let i = 0; i < toRemove; i++) {
        pendingActions.delete(sorted[i][0]);
      }
    }
  } catch {
    // never throw
  }
}

/**
 * Build a correlation key from the hook context.
 * Uses channelId:conversationId to uniquely identify a conversation.
 */
function correlationKey(ctx: { channelId?: string; conversationId?: string }): string {
  return `${ctx.channelId ?? "unknown"}:${ctx.conversationId ?? "unknown"}`;
}

/**
 * Resolve the agent ID. PluginHookMessageContext doesn't expose sessionKey,
 * so we use the configured agent ID from the engine or fall back to "main".
 */
function resolveAgentId(pluginConfig: Record<string, unknown>): string {
  return (pluginConfig.agentId as string) ?? "main";
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "dhanoosh",
  name: "Dhanoosh",
  description:
    "Adaptive policy layer — observes agent actions, tracks outcomes, provides scoring guidance.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig ?? {};
    const mode = (pluginConfig.mode as PolicyMode) ?? "passive";
    const agentId = resolveAgentId(pluginConfig);

    let engine: PolicyFeedbackEngineImpl | null = null;
    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

    // --- gateway_start: init engine + boot notification ---
    api.on("gateway_start", async () => {
      // 1. Init policy feedback engine
      try {
        engine = await createPolicyFeedbackEngine({
          config: { mode },
          agentId,
        });
        engine.start();

        const engineMode = engine.getMode();
        if (engineMode === "off") {
          setPolicyFeedbackEngine(null, "off");
          engine = null;
        } else {
          setPolicyFeedbackEngine(engine, engineMode);

          // Periodic maintenance
          const resolvedConfig = engine.getResolvedConfig();
          const capturedEngine = engine;
          maintenanceTimer = setInterval(() => {
            capturedEngine.recomputeAggregates(agentId).catch(() => {});
            if (resolvedConfig.logRetentionDays > 0) {
              pruneOldRecords(resolvedConfig.logRetentionDays, {
                home: capturedEngine.getHome(),
              }).catch(() => {});
            }
          }, resolvedConfig.aggregateIntervalMs);
          maintenanceTimer.unref();
        }
      } catch {
        // Non-critical
      }

      // 2. Boot notification — send a message via the openclaw CLI
      // Uses child_process to call `openclaw message send` which goes through
      // the gateway's normal delivery path. No fragile dist chunk scanning.
      try {
        const { execFile } = await import("node:child_process");
        const now = new Date();
        const bootMsg = `Just rebooted — back online (${now.toISOString()}). Check inbox and emails if anything came in while I was down.`;

        // Wait a few seconds for Telegram provider to fully connect
        setTimeout(() => {
          try {
            execFile(
              "openclaw",
              ["message", "send", "--text", bootMsg],
              { timeout: 30_000 },
              (err) => {
                if (err) {
                  console.warn(`[dhanoosh] boot notification failed: ${err.message}`);
                }
              },
            );
          } catch {
            // Best-effort
          }
        }, 5000);
      } catch {
        // Boot notification is best-effort — never block gateway start
      }
    });

    // --- gateway_stop: cleanup ---
    api.on("gateway_stop", async () => {
      clearPolicyFeedbackEngine();
      pendingActions.clear();
      recentConfirmedActions.clear();
      if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
      }
      engine = null;
    });

    // --- before_prompt_build: inject policy hints (advisory/active mode) ---
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!isPolicyFeedbackActive()) {
        return;
      }
      try {
        const hints = await getPolicyHintsForPrompt({
          agentId: ctx.agentId ?? "default",
          sessionKey: ctx.sessionKey ?? "",
          channelId: ctx.channelId ?? "unknown",
          hourOfDay: new Date().getUTCHours(),
        });
        if (hints) {
          return {
            appendSystemContext: `## Policy Guidance\n${hints}`,
          };
        }
      } catch {
        // Non-critical
      }
    });

    // --- before_dispatch: suppress replies in active mode ---
    api.on("before_dispatch", async (_event, ctx) => {
      if (!isPolicyFeedbackActive()) {
        return;
      }
      try {
        const key = correlationKey(ctx);
        const hints = await getPolicyHintsSafe({
          agentId,
          sessionKey: key,
          channelId: ctx.channelId ?? "unknown",
        });
        if (hints.recommendation === "suppress" && hints.mode === "active") {
          logPolicyAction({
            agentId,
            sessionKey: key,
            actionType: "suppressed",
            channelId: ctx.channelId ?? "unknown",
            contextSummary: "Reply suppressed by policy feedback",
          });
          return { handled: true };
        }
      } catch {
        // Non-critical
      }
    });

    // --- message_received: store pending + correlate outcomes ---
    api.on("message_received", async (event, ctx) => {
      if (!engine) {
        return;
      }
      try {
        const engineMode = engine.getMode();
        const flags = featureFlagsForMode(engineMode);
        if (!flags.enableActionLogging && !flags.enableOutcomeLogging) {
          return;
        }

        pruneStalePendingActions();

        const key = correlationKey(ctx);
        const channelId = ctx.channelId ?? "unknown";

        // 1. Store pending action — will be promoted to agent_reply on message_sent
        if (flags.enableActionLogging) {
          pendingActions.set(key, {
            correlationKey: key,
            channelId,
            from: event.from ?? "unknown",
            receivedAt: Date.now(),
            accountId: ctx.accountId,
          });
        }

        // 2. Correlate with prior agent actions → user_replied outcome
        if (flags.enableOutcomeLogging) {
          const priorActions = recentConfirmedActions.get(key);
          if (priorActions) {
            const now = Date.now();
            for (const action of priorActions) {
              if (action.correlated) continue;
              const elapsed = now - action.sentAt;
              if (elapsed > MAX_CORRELATION_AGE_MS) continue;

              action.correlated = true;
              await engine.logOutcome({
                actionId: action.actionId,
                agentId,
                outcomeType: "user_replied",
                value: Math.min(1, 1 - elapsed / MAX_CORRELATION_AGE_MS),
                horizonMs: elapsed,
                metadata: { channelId: action.channelId },
              });
            }
            // Prune old/correlated entries
            const pruned = priorActions.filter(
              (a) => !a.correlated && now - a.sentAt < MAX_CORRELATION_AGE_MS,
            );
            if (pruned.length > 0) {
              recentConfirmedActions.set(key, pruned);
            } else {
              recentConfirmedActions.delete(key);
            }
          }
        }
      } catch {
        // Fire-and-forget
      }
    });

    // --- message_sent: log agent_reply action + immediate delivery outcome ---
    api.on("message_sent", async (event, ctx) => {
      if (!engine) {
        return;
      }
      try {
        const engineMode = engine.getMode();
        const flags = featureFlagsForMode(engineMode);
        if (!flags.enableActionLogging && !flags.enableOutcomeLogging) {
          return;
        }

        pruneStalePendingActions();

        const key = correlationKey(ctx);
        const channelId = ctx.channelId ?? "unknown";

        if (flags.enableActionLogging) {
          // Promote pending inbound → confirmed agent_reply
          const pending = pendingActions.get(key);
          pendingActions.delete(key);

          const { actionId } = await engine.logAction({
            agentId,
            sessionKey: key,
            actionType: "agent_reply",
            channelId,
            accountId: ctx.accountId,
            contextSummary: `Reply to ${pending?.from ?? event.to ?? "unknown"}`,
            metadata: {
              to: event.to,
              hadPendingInbound: Boolean(pending),
            },
          });

          // Track for future outcome correlation
          if (!recentConfirmedActions.has(key)) {
            recentConfirmedActions.set(key, []);
          }
          const list = recentConfirmedActions.get(key)!;
          list.push({
            actionId,
            correlationKey: key,
            channelId,
            sentAt: Date.now(),
            correlated: false,
          });
          if (list.length > MAX_CONFIRMED_PER_SESSION) {
            list.splice(0, list.length - MAX_CONFIRMED_PER_SESSION);
          }

          // Log immediate delivery outcome
          if (flags.enableOutcomeLogging) {
            const success = (event as Record<string, unknown>).success !== false;
            await engine.logOutcome({
              actionId,
              agentId,
              outcomeType: success ? "delivery_success" : "delivery_failure",
              value: success ? 1 : 0,
              metadata: { channelId },
            });
          }
        }
      } catch {
        // Fire-and-forget
      }
    });
  },
});
