import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, mistralConversationsApi } from "@earendil-works/pi-ai/compat";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { resolveVibeCredential, vibeApiKeyAuth, vibeAuthFilePath } from "./auth.js";
import { VIBE_BASE_URL, fetchVibeCatalog, type VibeChatModel } from "./catalog.js";
import { vibeOAuth, vibeOAuthToAuth } from "./oauth.js";

const PROVIDER_ID = "vibe";
const PROVIDER_NAME = "Mistral Vibe";
/** pi does not refresh dynamic catalogs before model selection, so warm one here. */
const STARTUP_FETCH_TIMEOUT_MS = 8_000;

async function warmCatalog(): Promise<VibeChatModel[]> {
  if (process.env.PI_OFFLINE !== undefined) return [];
  const credential = await resolveVibeCredential();
  if (!credential) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STARTUP_FETCH_TIMEOUT_MS);
  try {
    return await fetchVibeCatalog(credential.token, controller.signal, VIBE_BASE_URL, PROVIDER_ID, credential.headers);
  } catch {
    // Empty baseline: /login vibe and the next refresh still recover the catalog.
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Live discovery only: models come from the Vibe catalog endpoint, never from a hardcoded list.
  const baselineModels = await warmCatalog();

  const provider = createProvider<"mistral-conversations">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: VIBE_BASE_URL,
    auth: { apiKey: vibeApiKeyAuth, oauth: vibeOAuth },
    api: mistralConversationsApi(),
    models: baselineModels,
    fetchModels: async (context: RefreshModelsContext): Promise<VibeChatModel[]> => {
      const cached = (context.stored?.models ?? []).filter(
        (model): model is VibeChatModel => model.provider === PROVIDER_ID && model.type === "chat",
      );
      if (!context.allowNetwork || context.signal.aborted) return cached;

      let token: string | undefined;
      let headers: Record<string, string> | undefined;
      const credential = context.credential;
      if (credential?.type === "api_key") {
        token = credential.key;
      } else if (credential?.type === "oauth") {
        const auth = vibeOAuthToAuth(credential);
        token = auth.apiKey;
        headers = auth.headers;
      } else {
        const resolved = await resolveVibeCredential();
        token = resolved?.token;
        headers = resolved?.headers;
      }
      // No credential: keep the stored/startup catalog instead of wiping it.
      if (!token) return cached.length > 0 ? cached : baselineModels;

      return fetchVibeCatalog(token, context.signal, context.baseUrl ?? VIBE_BASE_URL, PROVIDER_ID, headers);
    },
  });

  pi.registerProvider(provider);

  pi.registerCommand("vibe", {
    description: "Show Mistral Vibe provider status (registration, credential source, live catalog)",
    handler: async (_args, ctx) => {
      const registered = ctx.modelRegistry?.getProvider?.(PROVIDER_ID);
      const status = ctx.modelRegistry?.getProviderAuthStatus?.(PROVIDER_ID);
      const models = registered?.getModels?.() ?? [];
      const credential = await resolveVibeCredential();
      const lines = [
        `provider=${PROVIDER_ID} name=${PROVIDER_NAME} registered=${registered ? "yes" : "no"}`,
        `credential=${credential ? credential.source : "missing (use /login vibe → Sign in with your Mistral account)"}`,
        `tenant-headers=${credential?.headers ? Object.keys(credential.headers).join(",") : "none"}`,
        `configured=${status?.configured ? "yes" : "no"}${status?.source ? ` (${status.source})` : ""}`,
        `oauth-login=${vibeOAuth.loginLabel}`,
        `models=${models.length}${models.length > 0 ? `: ${models.slice(0, 6).map((model) => model.id).join(", ")}` : ""}`,
        `le-vibe-auth=${vibeAuthFilePath()}`,
      ];
      const text = `pi-vibe\n${lines.join("\n")}`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) return;
    const registry = ctx.modelRegistry;
    if (typeof registry?.refresh !== "function") return;
    registry.refresh({ providers: [PROVIDER_ID] }).catch(() => {
      // Keep the startup catalog when the live catalog is unreachable.
    });
  });
}
