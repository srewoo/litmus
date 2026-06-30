/**
 * Dynamic host-permission requests. MCP servers live on arbitrary origins, so
 * litmus does NOT take a static broad host grant; instead it requests permission
 * for a specific origin at connect time (ADR 0003). The request must be made
 * from a user gesture (e.g. the Connect button click) per Chrome's rules.
 */

/** The Chrome permissions surface litmus relies on (injectable for tests). */
export interface PermissionsApi {
  contains(perms: { origins: string[] }): Promise<boolean>;
  request(perms: { origins: string[] }): Promise<boolean>;
}

/** Derive the `https://host/*` origin pattern Chrome wants from a server URL. */
export function originPatternFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/*`;
}

function defaultApi(): PermissionsApi {
  return chrome.permissions as unknown as PermissionsApi;
}

/**
 * Ensure host permission for `url`'s origin, requesting it if not already held.
 * Returns true if granted. Call this synchronously inside a click handler.
 */
export async function ensureHostPermission(url: string, api: PermissionsApi = defaultApi()): Promise<boolean> {
  const origins = [originPatternFor(url)];
  if (await api.contains({ origins })) return true;
  return api.request({ origins });
}

/**
 * Whether host permission for `url`'s origin is ALREADY held — a gesture-free
 * check (`contains` only, never `request`). The run orchestrator uses this: it
 * executes outside a user gesture, so it cannot prompt for a grant; it must
 * verify the origin was authorized earlier (via the MCP panel's Connect button)
 * and refuse to send traffic + the auth secret to an unauthorized origin.
 */
export async function hasHostPermission(url: string, api: PermissionsApi = defaultApi()): Promise<boolean> {
  return api.contains({ origins: [originPatternFor(url)] });
}
