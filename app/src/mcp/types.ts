/**
 * MCP domain types. These describe a server connection and the primitives a
 * server exposes (tools / resources / prompts). Server responses are validated
 * by `mcp/schema.ts` before being surfaced as these types (CLAUDE.md: validate
 * everything that crosses a trust boundary).
 */

/** Transport kind. stdio is impossible in the MV3 sandbox; remote only. */
export type McpTransportKind = 'http' | 'sse';

/** A user-configured MCP server. Auth/secrets live only in chrome.storage.local. */
export interface McpServerConfig {
  /** Stable id used to reference this server from a scenario. */
  readonly id: string;
  readonly name: string;
  /** Endpoint URL (the Streamable-HTTP message endpoint). */
  readonly url: string;
  readonly transport: McpTransportKind;
  /** Optional Authorization header value, e.g. "Bearer xyz". */
  readonly authHeader?: string;
}

/** The capability flags a server advertises during the handshake. */
export interface McpCapabilities {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** Result of a successful handshake. */
export interface McpHandshake {
  readonly protocolVersion: string;
  readonly capabilities: McpCapabilities;
  readonly serverInfo: McpServerInfo;
  /** Session id echoed back on subsequent requests, when the server uses one. */
  readonly sessionId?: string;
}

/** A tool the server exposes. `inputSchema` is a JSON Schema object. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptArg {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly McpPromptArg[];
}

/** Normalized result of a `tools/call`. `text` is the concatenated text content. */
export interface McpCallResult {
  readonly isError: boolean;
  /** Concatenated text blocks, for feeding back to the model / display. */
  readonly text: string;
  /** The raw structured content array, kept for diagnostics. */
  readonly content: readonly unknown[];
}
