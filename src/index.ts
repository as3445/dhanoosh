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
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk";
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

export default definePluginEntry({
  id: "dhanoosh",
  name: "Dhanoosh",
  description:
    "Adaptive policy layer — observes agent actions, tracks outcomes, provides scoring guidance.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig ?? {};
    const mode = (pluginConfig.mode as PolicyMode) ?? "passive";

    let engine: PolicyFeedbackEngineImpl | null = null;
    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

    // --- gateway_start: init engine ---
    api.on("gateway_start", async () => {
      try {
        engine = await createPolicyFeedbackEngine({
          config: { mode },
          agentId: "default",
        });
        engine.start();

        const engineMode = engine.getMode();
        if (engineMode === "off") {
          setPolicyFeedbackEngine(null, "off");
          engine = null;
          return;
        }

        setPolicyFeedbackEngine(engine, engineMode);

        // Periodic maintenance: recompute aggregates and prune old logs
        const resolvedConfig = engine.getResolvedConfig();
        const capturedEngine = engine;
        maintenanceTimer = setInterval(() => {
          capturedEngine.recomputeAggregates("default").catch(() => {});
          if (resolvedConfig.logRetentionDays > 0) {
            pruneOldRecords(resolvedConfig.logRetentionDays, {
              home: capturedEngine.getHome(),
            }).catch(() => {});
          }
        }, resolvedConfig.aggregateIntervalMs);
        maintenanceTimer.unref();
      } catch {
        // Non-critical — fail silently
      }
    });

    // --- gateway_stop: cleanup ---
    api.on("gateway_stop", async () => {
      clearPolicyFeedbackEngine();
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
    api.on("before_dispatch", async (event, ctx) => {
      if (!isPolicyFeedbackActive()) {
        return;
      }
      try {
        const hints = await getPolicyHintsSafe({
          agentId: ctx.senderId ?? "default",
          sessionKey: ctx.sessionKey ?? "",
          channelId: ctx.channelId ?? "unknown",
        });
        if (hints.recommendation === "suppress" && hints.mode === "active") {
          logPolicyAction({
            agentId: ctx.senderId ?? "default",
            sessionKey: ctx.sessionKey ?? "",
            actionType: "suppressed",
            channelId: ctx.channelId ?? "unknown",
            contextSummary: "Reply suppressed by policy feedback",
          });
          return { handled: true };
        }
      } catch {
        // Non-critical — allow dispatch to proceed
      }
    });

    // --- message_received: track inbound for outcome correlation ---
    api.on("message_received", async (event, ctx) => {
      if (!engine) {
        return;
      }
      try {
        // Log for outcome correlation — if we recently sent a reply and the
        // user is now replying, that's a positive outcome signal.
        logPolicyAction({
          agentId: ctx.senderId ?? "default",
          sessionKey: ctx.sessionKey ?? "",
          actionType: "agent_reply",
          channelId: ctx.channelId ?? "unknown",
          contextSummary: `Received from ${event.from}`,
        });
      } catch {
        // Fire-and-forget
      }
    });

    // --- message_sent: log agent reply actions ---
    api.on("message_sent", async (event, ctx) => {
      if (!engine) {
        return;
      }
      try {
        logPolicyAction({
          agentId: ctx.senderId ?? "default",
          sessionKey: ctx.sessionKey ?? "",
          actionType: "agent_reply",
          channelId: ctx.channelId ?? "unknown",
          contextSummary: `Reply to ${event.to}`,
        });
      } catch {
        // Fire-and-forget
      }
    });
  },
});
