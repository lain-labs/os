import { createLogger } from "../logger.js";
import {
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../types.js";

const log = createLogger("model:mock");

/**
 * Deterministic offline model. Used when no ANTHROPIC_API_KEY is set so the
 * full runtime loop (memory, providers, actions) stays demonstrable without
 * network access. It is intentionally dumb: it echoes intent and will trigger
 * a tool call when the user's message obviously asks for one.
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  modelFor(tier: ModelTier): string {
    return `mock-${tier}`;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    log.debug("offline mock generate");
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    const lower = text.toLowerCase();

    // Heuristic tool routing so the action pipeline is exercised offline.
    if (request.tools?.length) {
      const wantsBalance = /balance|how much/.test(lower);
      const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
      const balanceTool = request.tools.find((t) => t.name === "check_balance");
      if (wantsBalance && balanceTool) {
        return {
          text: "",
          toolCalls: [
            {
              name: "check_balance",
              input: addrMatch ? { address: addrMatch[0] } : {},
            },
          ],
          model: this.modelFor(request.tier),
          provider: this.name,
        };
      }
    }

    // Synthesis round after tool calls: report the results instead of echoing
    // the runtime's scaffolding back at the user.
    if (text.startsWith("Tool results:")) {
      const results = text
        .split("\n")
        .filter((l) => l.startsWith("Tool ") && l.includes("->"))
        .join("; ");
      return {
        text: `[offline] ${truncate(results, 300)}`,
        toolCalls: [],
        model: this.modelFor(request.tier),
        provider: this.name,
      };
    }

    const reply = text
      ? `[offline] I hear you: "${truncate(text, 160)}". Set ANTHROPIC_API_KEY for a real mind.`
      : "[offline] ...the Wired is quiet. Set ANTHROPIC_API_KEY to wake me.";

    return { text: reply, toolCalls: [], model: this.modelFor(request.tier), provider: this.name };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
