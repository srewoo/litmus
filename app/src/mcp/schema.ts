/**
 * Zod schemas for MCP server responses. Every server reply is validated here
 * before the typed core touches it (CLAUDE.md: validate all external input at
 * the trust boundary). Schemas are intentionally lenient on unknown extra keys
 * (servers add fields) but strict on the shapes litmus depends on.
 */
import { z } from 'zod';
import type {
  McpCapabilities,
  McpCallResult,
  McpHandshake,
  McpPrompt,
  McpResource,
  McpToolDescriptor,
} from './types';

const CapabilityFlagsSchema = z
  .object({
    tools: z.unknown().optional(),
    resources: z.unknown().optional(),
    prompts: z.unknown().optional(),
  })
  .passthrough();

export const InitializeResultSchema = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: CapabilityFlagsSchema.default({}),
    serverInfo: z
      .object({ name: z.string().default('unknown'), version: z.string().default('0.0.0') })
      .default({ name: 'unknown', version: '0.0.0' }),
  })
  .passthrough();

export const ToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    // Servers send `inputSchema`; default to an open object when absent.
    inputSchema: z.record(z.unknown()).default({ type: 'object' }),
  })
  .passthrough();

export const ToolsListResultSchema = z.object({ tools: z.array(ToolDescriptorSchema).default([]) }).passthrough();

export const ResourceSchema = z
  .object({
    uri: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

export const ResourcesListResultSchema = z
  .object({ resources: z.array(ResourceSchema).default([]) })
  .passthrough();

export const PromptArgSchema = z
  .object({ name: z.string().min(1), description: z.string().optional(), required: z.boolean().optional() })
  .passthrough();

export const PromptSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    arguments: z.array(PromptArgSchema).optional(),
  })
  .passthrough();

export const PromptsListResultSchema = z.object({ prompts: z.array(PromptSchema).default([]) }).passthrough();

const ContentBlockSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

export const CallToolResultSchema = z
  .object({ content: z.array(ContentBlockSchema).default([]), isError: z.boolean().default(false) })
  .passthrough();

/* ---- Mappers: validated Zod shape → litmus domain type ---- */

export function toHandshake(result: unknown, sessionId?: string): McpHandshake {
  const r = InitializeResultSchema.parse(result);
  const capabilities: McpCapabilities = {
    tools: r.capabilities.tools !== undefined,
    resources: r.capabilities.resources !== undefined,
    prompts: r.capabilities.prompts !== undefined,
  };
  return {
    protocolVersion: r.protocolVersion,
    capabilities,
    serverInfo: { name: r.serverInfo.name, version: r.serverInfo.version },
    ...(sessionId ? { sessionId } : {}),
  };
}

export function toToolDescriptors(result: unknown): McpToolDescriptor[] {
  return ToolsListResultSchema.parse(result).tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
  }));
}

export function toResources(result: unknown): McpResource[] {
  return ResourcesListResultSchema.parse(result).resources.map((r) => ({
    uri: r.uri,
    ...(r.name ? { name: r.name } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.mimeType ? { mimeType: r.mimeType } : {}),
  }));
}

export function toPrompts(result: unknown): McpPrompt[] {
  return PromptsListResultSchema.parse(result).prompts.map((p) => ({
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(p.arguments ? { arguments: p.arguments } : {}),
  }));
}

export function toCallResult(result: unknown): McpCallResult {
  const r = CallToolResultSchema.parse(result);
  const text = r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
  return { isError: r.isError, text, content: r.content };
}
