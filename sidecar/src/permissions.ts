/** `canUseTool`: turns a tool the SDK will not auto-approve into a decision made outside
 * this process. Only reached when the permission flow falls through to a prompt. */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { HostLink, PERMISSION_TIMEOUT_MS } from "./host.ts";
import type { JsonObject, PermissionDecision } from "./protocol.ts";

interface HostPermissionReply {
  decision: PermissionDecision;
  /** Present when the host edited the call before allowing it. */
  updatedInput?: JsonObject;
  /** The reason shown to the model on a deny. */
  message?: string;
}

/** Never resolves to `null`: the SDK reads that as "answered on another channel" and the
 * call then blocks forever. Every path ends in an explicit allow or deny. */
export function createPermissionHandler(link: HostLink, sessionId: string): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    let reply: HostPermissionReply;
    try {
      reply = await link.request<HostPermissionReply>({
        prefix: "perm",
        label: `permission for ${toolName}`,
        sessionId,
        timeoutMs: PERMISSION_TIMEOUT_MS,
        signal: options.signal,
        build: (id) => ({
          t: "permission_request",
          id,
          sessionId,
          tool: toolName,
          input: input as JsonObject,
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { behavior: "deny", message: `the IDE did not approve this call: ${detail}` };
    }

    if (reply.decision === "allow") {
      // Omit `updatedInput` entirely when the host did not edit the call; an empty object
      // would replace the arguments the model chose.
      return reply.updatedInput
        ? { behavior: "allow", updatedInput: reply.updatedInput }
        : { behavior: "allow" };
    }
    return { behavior: "deny", message: reply.message ?? "the user rejected this call" };
  };
}
