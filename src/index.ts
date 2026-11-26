import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, mistralConversationsApi } from "@earendil-works/pi-ai/compat";
import type { ProviderHeaders, RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { vibeApiKeyAuth } from "./auth.js";
import { VIBE_BASE_URL, fetchVibeCatalog, type VibeChatModel } from "./catalog.js";
import { vibeOAuth, vibeOAuthToAuth } from "./oauth.js";

const PROVIDER_ID = "vibe";
const PROVIDER_NAME = "Mistral Vibe";

export default async function (pi: ExtensionAPI): Promise<void> {
  // Live discovery only: models come from the Vibe catalog endpoint, never from a hardcoded list.
  // Nothing is fetched until a credential exists — signing in with an account is the default path.
  const provider = createProvider<"mistral-conversations">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: VIBE_BASE_URL,
    auth: { apiKey: vibeApiKeyAuth, oauth: vibeOAuth },
    api: mistralConversationsApi(),
    models: [],
    fetchModels: async (context: RefreshModelsContext): Promise<VibeChatModel[]> => {
      const cached = (context.stored?.models ?? []).filter(
        (model): model is VibeChatModel => model.provider === PROVIDER_ID && model.type === "chat",
      );
      if (!context.allowNetwork || context.signal.aborted) return cached;

      let token: string | undefined;
      let headers: ProviderHeaders | undefined;
      const credential = context.credential;
      if (credential?.type === "api_key") {
        token = credential.key;
      } else if (credential?.type === "oauth") {
        try {
          const auth = vibeOAuthToAuth(credential);
          token = auth.apiKey;
          headers = auth.headers;
        } catch {
          // Unusable stored credential: keep the catalog instead of failing the refresh.
          return cached;
        }
      }
      // No credential: keep the stored catalog instead of wiping it.
      if (!token) return cached;

      return fetchVibeCatalog(token, context.signal, context.baseUrl ?? VIBE_BASE_URL, PROVIDER_ID, headers);
    },
  });

  pi.registerProvider(provider);

  pi.registerCommand("vibe", {
    description: "Show Mistral Vibe provider status (registration, credential, live catalog)",
    handler: async (_args, ctx) => {
      const registered = ctx.modelRegistry?.getProvider?.(PROVIDER_ID);
      const status = ctx.modelRegistry?.getProviderAuthStatus?.(PROVIDER_ID);
      const models = registered?.getModels?.() ?? [];
      const usingOAuth = models.length > 0 ? ctx.modelRegistry?.isUsingOAuth?.(models[0]) : undefined;
      const authLine = !status?.configured
        ? "none (run /login vibe → " + vibeOAuth.loginLabel + ")"
        : `${usingOAuth ? "oauth" : "api_key"} (${status.source ?? "stored"})`;
      const lines = [
        `provider=${PROVIDER_ID} name=${PROVIDER_NAME} registered=${registered ? "yes" : "no"}`,
        `auth=${authLine}`,
        `models=${models.length}${models.length > 0 ? `: ${models.slice(0, 6).map((model) => model.id).join(", ")}` : ""}`,
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
