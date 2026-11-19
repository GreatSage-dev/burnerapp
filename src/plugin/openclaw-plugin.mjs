import { BurnerRegistry } from "../governor/capability-gate.mjs";

export function createBurnerPlugin(options = {}) {
  const registry = options.registry || new BurnerRegistry(options);

  const plugin = {
    id: "burnerapp",
    name: "BurnerApp Capability Governor",
    description:
      "Enforces scoped ephemeral capability manifests on OpenClaw Canvas micro-apps via typed before_tool_call hooks.",
    registry,

    register(api) {
      if (!api || typeof api.on !== "function") {
        throw new Error("OpenClaw plugin API must provide typed hook registration via api.on(...)");
      }

      api.on(
        "before_tool_call",
        async (event, ctx = {}) => {
          const resolvedId = registry.resolveBurnerId(event, ctx);
          const shouldEnforce = Boolean(resolvedId) || Boolean(ctx.enforceAllTools);

          if (!shouldEnforce) {
            return {};
          }

          const evaluation = registry.evaluateBeforeToolCall(
            { ...event, burnerId: resolvedId },
            ctx
          );

          if (!evaluation.allowed) {
            return {
              block: true,
              blockReason: `[${evaluation.rule}] ${evaluation.reason} (receipt:${evaluation.receipt.receiptId})`
            };
          }

          return {};
        },
        { priority: 100 }
      );
    }
  };

  return plugin;
}

const defaultPlugin = createBurnerPlugin();
export default defaultPlugin;
