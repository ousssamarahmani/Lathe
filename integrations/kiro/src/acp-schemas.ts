/**
 * Zod schemas for inbound ACP (JSON-RPC 2.0) messages. Everything Kiro sends is
 * untrusted, so each message is parsed here before the adapter looks at it.
 * Shapes follow the P0-04 spike (`docs/spikes/kiro-acp.md`). Unknown fields are kept
 * out of the parsed result and unknown notification methods are ignored.
 */
import { z } from 'zod';

const RpcId = z.union([z.number().int(), z.string().min(1).max(200)]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string().max(10_000),
  data: z.unknown().optional(),
});

/** One inbound line: a response, a request (has `id` and `method`) or a notification. */
export const InboundMessage = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: RpcId.optional(),
    method: z.string().min(1).max(200).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: RpcError.optional(),
  })
  .refine(
    (m) => m.method !== undefined || (m.id !== undefined && (m.result !== undefined || m.error)),
    'expected a method, or an id with a result or error',
  );
export type InboundMessage = z.infer<typeof InboundMessage>;

export const InitializeResult = z.object({ protocolVersion: z.number().int() });

export const NewSessionResult = z.object({ sessionId: z.string().min(1).max(200) });

export const PromptResult = z.object({ stopReason: z.string().min(1).max(100) });

const ToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

const UpdateBase = z.object({ sessionUpdate: z.string().min(1).max(100) });

export const AgentMessageChunk = UpdateBase.extend({
  sessionUpdate: z.literal('agent_message_chunk'),
  content: z.object({ type: z.string(), text: z.string().optional() }),
});

export const ToolCallUpdateMsg = UpdateBase.extend({
  sessionUpdate: z.literal('tool_call'),
  toolCallId: z.string().min(1).max(200),
  title: z.string().optional(),
  status: ToolStatus.optional(),
  rawInput: z.unknown().optional(),
});

export const ToolCallProgressMsg = UpdateBase.extend({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string().min(1).max(200),
  status: ToolStatus.optional(),
  rawOutput: z.unknown().optional(),
});

export const SessionUpdateParams = z.object({
  sessionId: z.string().min(1).max(200),
  update: UpdateBase.loose(),
});

export const PermissionOption = z.object({
  optionId: z.string().min(1).max(200),
  name: z.string().max(500).optional(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

export const PermissionParams = z.object({
  sessionId: z.string().min(1).max(200),
  toolCall: z.object({
    toolCallId: z.string().min(1).max(200),
    title: z.string().optional(),
    kind: z.string().max(100).optional(),
    locations: z.array(z.object({ path: z.string().max(4096) })).optional(),
    rawInput: z.unknown().optional(),
  }),
  options: z.array(PermissionOption).max(20),
});
export type PermissionParams = z.infer<typeof PermissionParams>;
