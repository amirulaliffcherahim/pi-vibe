import type { ApiKeyAuth } from "@earendil-works/pi-ai/compat";

export const VIBE_AUTH_NAME = "Mistral Vibe API key";

/**
 * API-key auth is opt-in: only a key saved by `/login vibe` counts. Ambient sources
 * (`MISTRAL_API_KEY`, `~/.le-vibe/auth.json`) are deliberately not read, so pi never
 * reports the provider as "API key configured" and account sign-in is the default path.
 */
export const vibeApiKeyAuth: ApiKeyAuth = {
  name: VIBE_AUTH_NAME,
  login: async (interaction) => {
    interaction.signal.throwIfAborted();
    const key = await interaction.prompt({
      type: "secret",
      message: `Enter ${VIBE_AUTH_NAME}`,
    });
    interaction.signal.throwIfAborted();
    return { type: "api_key", key: key.trim() };
  },
  check: async ({ credential, signal }) => {
    signal.throwIfAborted();
    return credential?.key ? { type: "api_key", source: "stored credential" } : undefined;
  },
  resolve: async ({ credential, signal }) => {
    signal.throwIfAborted();
    if (!credential?.key) return undefined;
    return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
  },
};
