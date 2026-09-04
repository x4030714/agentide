/**
 * `canUseTool`: the round trip from a tool the SDK will not auto-approve to a decision
 * made outside this process.
 *
 * The SDK calls this only when the permission flow falls through to a prompt -- calls
 * covered by `allowedTools`, a settings allow rule or a permissive `permissionMode` never
 * reach here. That is the right granularity for Phase 2's Strict mode, which works by
 * narrowing what is pre-approved rather than by intercepting everything.
 */

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

/**
 * A `canUseTool` bound to one session.
 *
 * Never resolves to `null`: the SDK treats that as "the application already answered on
 * another channel" and, if nothing did, the tool call blocks forever with no timeout.
 * Every path here ends in an explicit allow or deny, including the failure paths -- a
 * host that dies mid-prompt denies rather than hangs.
 */
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
