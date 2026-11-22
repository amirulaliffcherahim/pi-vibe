import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiKeyAuth, ProviderHeaders } from "@earendil-works/pi-ai/compat";

/** Env var Vibe itself reads, kept identical to le-vibe's `PROVIDER_ENV_KEYS["vibe"]`. */
export const VIBE_ENV_KEY = "MISTRAL_API_KEY";
export const VIBE_AUTH_NAME = "Mistral Vibe API key";

interface VibeStoredCredential {
  type?: string;
  key?: string;
  access_token?: string;
  id_token?: string;
  expires_at?: number;
  organization_id?: string;
  workspace_id?: string;
}

export interface VibeCredential {
  token: string;
  source: string;
  /** Tenant headers required when the token is a Mistral OIDC id token. */
  headers?: ProviderHeaders;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const toBase64Url = (buffer: Buffer): string =>
    buffer.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** le-vibe sends `x-external-organization-id` / `x-external-workspace-id` alongside the id token. */
export function oidcTenantHeaders(credential: {
  organizationId?: unknown;
  workspaceId?: unknown;
}): { headers?: ProviderHeaders } {
  const headers: ProviderHeaders = {};
  const organizationId = typeof credential.organizationId === "string" ? credential.organizationId.trim() : "";
  const workspaceId = typeof credential.workspaceId === "string" ? credential.workspaceId.trim() : "";
  if (organizationId) headers["x-external-organization-id"] = organizationId;
  if (workspaceId) headers["x-external-workspace-id"] = workspaceId;
  return Object.keys(headers).length > 0 ? { headers } : {};
}

/** Same store le-vibe writes: `~/.le-vibe/auth.json` (override with `LE_VIBE_AUTH_FILE`). */
export function vibeAuthFilePath(): string {
  return process.env.LE_VIBE_AUTH_FILE || path.join(os.homedir(), ".le-vibe", "auth.json");
}

function readStoredVibeCredential(): VibeStoredCredential | undefined {
  try {
    const raw = fs.readFileSync(vibeAuthFilePath(), "utf8").replace(/^\uFEFF/u, "");
    const store: unknown = JSON.parse(raw);
    if (!store || typeof store !== "object") return undefined;
    const entry = (store as Record<string, unknown>).vibe;
    return entry && typeof entry === "object" ? (entry as VibeStoredCredential) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Port of le-vibe `resolve_api_key("vibe")`:
 * explicit (pi auth.json) → `MISTRAL_API_KEY` → `~/.le-vibe/auth.json` api key → live OIDC token.
 * le-vibe's OS-keyring fallback (`ai.mistral.vibe` / `ai.mistral.meow`) has no portable Node
 * reader, so on a keyring-only install run `le-vibe login --provider vibe` once or set `MISTRAL_API_KEY`.
 */
export async function resolveVibeCredential(
  getEnv: (name: string) => Promise<string | undefined> = async (name) => process.env[name],
): Promise<VibeCredential | undefined> {
  const envKey = (await getEnv(VIBE_ENV_KEY))?.trim();
  if (envKey) return { token: envKey, source: VIBE_ENV_KEY };

  const stored = readStoredVibeCredential();
  const savedKey = stored?.key?.trim();
  if (savedKey) return { token: savedKey, source: `${vibeAuthFilePath()} (vibe)` };

  const accessToken = stored?.access_token?.trim();
  const expiresAt = Number(stored?.expires_at ?? 0);
  if (accessToken && expiresAt * 1000 > Date.now()) {
    return {
      token: stored?.id_token?.trim() || accessToken,
      source: "~/.le-vibe OIDC token",
      ...oidcTenantHeaders({ organizationId: stored?.organization_id, workspaceId: stored?.workspace_id }),
    };
  }
  return undefined;
}

export const vibeApiKeyAuth: ApiKeyAuth = {
  name: VIBE_AUTH_NAME,
  login: async (interaction) => {
    interaction.signal.throwIfAborted();
    const key = await interaction.prompt({
      type: "secret",
      message: `Enter ${VIBE_AUTH_NAME} (or sign in with le-vibe)`,
    });
    interaction.signal.throwIfAborted();
    return { type: "api_key", key: key.trim() };
  },
  check: async ({ ctx, credential, signal }) => {
    signal.throwIfAborted();
    if (credential?.key) return { type: "api_key", source: "stored credential" };
    const resolved = await resolveVibeCredential((name) => ctx.env(name));
    return resolved ? { type: "api_key", source: resolved.source } : undefined;
  },
  resolve: async ({ ctx, credential, signal }) => {
    signal.throwIfAborted();
    if (credential?.key) {
      return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
    }
    const resolved = await resolveVibeCredential((name) => ctx.env(name));
    if (!resolved) return undefined;
    return {
      auth: { apiKey: resolved.token, ...(resolved.headers ? { headers: resolved.headers } : {}) },
      source: resolved.source,
    };
  },
};
