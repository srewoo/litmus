/**
 * MCP tool resolver (ADR 0003). Plugs a live MCP server into the agent loop's
 * tool-dispatch seam: the model's tool call is issued to the server for real via
 * `tools/call`, and the result is mapped back to the loop's `ToolResultRecord`
 * shape so trajectory scoring (`scoreScenario`) is identical to the mock path.
 *
 * `known` is whether the called tool exists in the discovered catalog; `argsValid`
 * is checked against the discovered input schema with the same minimal validator
 * the mock path uses. A transport/RPC failure becomes an `{ error }` result so the
 * loop's recovery dimension can still observe it (rather than aborting the run).
 */
import type { McpClient } from '../mcp/client';
import type { McpToolDescriptor } from '../mcp/types';
import type { ToolResolver, ToolResultRecord } from './agentRun';
import { validateArgsSchema } from './toolAssert';

export type { ToolResolver } from './agentRun';
export { defaultMockResolver as mockResolver } from './agentRun';

/** Build a resolver that dispatches the model's tool calls to a live MCP server. */
export function mcpResolver(client: McpClient, tools: readonly McpToolDescriptor[]): ToolResolver {
  const schemaByName = new Map(tools.map((t) => [t.name, t.inputSchema]));
  return async (call): Promise<ToolResultRecord> => {
    const schema = schemaByName.get(call.name);
    const known = schema !== undefined;
    const argsValid = known ? validateArgsSchema(call.arguments, schema).length === 0 : false;
    if (!known) {
      return { name: call.name, result: { error: 'unknown tool (not in server catalog)' }, known, argsValid };
    }
    try {
      const res = await client.callTool(call.name, call.arguments);
      const result = res.isError ? { error: res.text || 'tool reported an error' } : { value: res.text };
      return { name: call.name, result, known, argsValid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: call.name, result: { error: message }, known, argsValid };
    }
  };
}
