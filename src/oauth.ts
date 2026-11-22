import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai/compat";
import { oidcTenantHeaders, pkcePair } from "./auth.js";

/** Same OIDC application le-vibe signs in with (`python/le_vibe/providers/auth.py`). */
export const VIBE_OIDC_ISSUER = "https://auth.mistral.ai";
export const VIBE_OIDC_CLIENT_ID = "829da7e7-628f-4795-829a-8cca609c76d4";
export const VIBE_OIDC_AUDIENCE = "https://api.mistral.ai";
export const VIBE_OIDC_SCOPE = "openid offline_access email profile";
export const VIBE_OIDC_REDIRECT_URI = "http://127.0.0.1:8766/callback";

const LOGIN_TIMEOUT_MS = 180_000;

interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface TokenSet {
  access: string;
  refresh?: string;
  idToken?: string;
  expiresIn: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function discoverEndpoints(signal: AbortSignal): Promise<OidcEndpoints> {
  const response = await fetch(`${VIBE_OIDC_ISSUER}/.well-known/openid-configuration`, { signal });
  if (!response.ok) {
    throw new Error(`Mistral OIDC discovery failed: HTTP ${response.status}`);
  }
  const document = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = asString(document.authorization_endpoint);
  const tokenEndpoint = asString(document.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("Mistral OIDC discovery is missing authorization/token endpoints");
  }
  return { authorizationEndpoint, tokenEndpoint };
}

async function postTokenRequest(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<TokenSet> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal,
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = asString(payload.error_description) ?? asString(payload.error) ?? text.slice(0, 200);
    throw new Error(`Mistral token request failed: HTTP ${response.status} ${detail}`.trim());
  }
  const access = asString(payload.access_token);
  if (!access) throw new Error("Mistral token response did not include an access token");
  const expiresIn = Number(payload.expires_in);
  return {
    access,
    refresh: asString(payload.refresh_token),
    idToken: asString(payload.id_token),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}

/** Workspace/org discovery the Vibe API expects as `x-external-*` headers. */
export async function discoverVibeTenant(
  bearer: string,
  signal: AbortSignal,
): Promise<{ organizationId?: string; workspaceId?: string }> {
  try {
    const response = await fetch(
      `${VIBE_OIDC_AUDIENCE}/v1/users/me/workspaces?limit=100&offset=0`,
      { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, signal },
    );
    if (!response.ok) return {};
    const payload = (await response.json()) as { workspaces?: unknown };
    const first = Array.isArray(payload.workspaces) ? payload.workspaces[0] : undefined;
    if (!first || typeof first !== "object") return {};
    const workspace = first as Record<string, unknown>;
    return {
      organizationId: asString(workspace.organization_id),
      workspaceId: asString(workspace.id),
    };
  } catch {
    return {};
  }
}

interface CallbackListener {
  promise: Promise<{ code: string; state: string }>;
  close: () => void;
}

function waitForCallback(redirect: URL, expectedState: string): CallbackListener {
  let settle: (value: { code: string; state: string }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  promise.catch(() => {});

  const server = createCallbackServer((url, respond) => {
    if (url.pathname !== redirect.pathname) {
      respond(404, "<html><body><h3>Not found.</h3></body></html>");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    if (error) {
      respond(200, "<html><body><h3>Mistral sign-in failed.</h3><p>You can close this window.</p></body></html>");
      fail(new Error(`Mistral sign-in failed: ${error}`));
      return;
    }
    respond(200, "<html><body><h3>Mistral Vibe sign-in complete.</h3><p>You can close this window and return to pi.</p></body></html>");
    if (!code) {
      fail(new Error("Mistral sign-in callback is missing an authorization code"));
      return;
    }
    if (state !== expectedState) {
      fail(new Error("Mistral sign-in state mismatch"));
      return;
    }
    settle({ code, state });
  });

  server.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  server.listen(Number(redirect.port), redirect.hostname);
  return { promise, close: () => server.close() };
}

function createCallbackServer(
  handler: (url: URL, respond: (status: number, body: string) => void) => void,
): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handler(url, (status, body) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    });
  });
}

export async function loginVibeAccount(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const endpoints = await discoverEndpoints(interaction.signal);
  const { verifier, challenge } = pkcePair();
  const state = base64Url(randomBytes(24));
  const nonce = base64Url(randomBytes(24));
  const redirect = new URL(VIBE_OIDC_REDIRECT_URI);

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", VIBE_OIDC_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", VIBE_OIDC_REDIRECT_URI);
  authUrl.searchParams.set("scope", VIBE_OIDC_SCOPE);
  authUrl.searchParams.set("audience", VIBE_OIDC_AUDIENCE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const listener = waitForCallback(redirect, state);
  const timeout = setTimeout(() => {
    listener.close();
    interaction.signal.throwIfAborted();
  }, LOGIN_TIMEOUT_MS);

  try {
    interaction.notify({
      type: "auth_url",
      url: authUrl.toString(),
      instructions: `Complete Mistral Vibe sign-in in your browser. pi captures the callback on ${VIBE_OIDC_REDIRECT_URI}.`,
    });

    const { code } = await Promise.race([
      listener.promise,
      new Promise<never>((_resolve, reject) => {
        if (interaction.signal.aborted) {
          reject(new Error("Mistral sign-in cancelled"));
          return;
        }
        interaction.signal.addEventListener("abort", () => reject(new Error("Mistral sign-in cancelled")), {
          once: true,
        });
      }),
    ]);

    const tokens = await postTokenRequest(
      endpoints.tokenEndpoint,
      {
        grant_type: "authorization_code",
        client_id: VIBE_OIDC_CLIENT_ID,
        code,
        redirect_uri: VIBE_OIDC_REDIRECT_URI,
        code_verifier: verifier,
      },
      interaction.signal,
    );

    const { organizationId, workspaceId } = await discoverVibeTenant(
      tokens.idToken ?? tokens.access,
      interaction.signal,
    );

    return {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh ?? "",
      expires: Date.now() + tokens.expiresIn * 1000,
      idToken: tokens.idToken,
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: VIBE_OIDC_CLIENT_ID,
      organizationId,
      workspaceId,
    };
  } finally {
    clearTimeout(timeout);
    listener.close();
  }
}

export async function refreshVibeAccount(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const tokenEndpoint = asString(credential.tokenEndpoint) ?? `${VIBE_OIDC_ISSUER}/oauth/token`;
  const clientId = asString(credential.clientId) ?? VIBE_OIDC_CLIENT_ID;
  const refreshToken = asString(credential.refresh);
  if (!refreshToken) throw new Error("Mistral Vibe credential has no refresh token; run /login vibe again");

  const tokens = await postTokenRequest(
    tokenEndpoint,
    { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken },
    signal,
  );

  const idToken = tokens.idToken ?? asString(credential.idToken);
  let organizationId = asString(credential.organizationId);
  let workspaceId = asString(credential.workspaceId);
  if (!organizationId && idToken) {
    const tenant = await discoverVibeTenant(idToken, signal);
    organizationId = tenant.organizationId;
    workspaceId = workspaceId ?? tenant.workspaceId;
  }

  return {
    ...credential,
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh ?? refreshToken,
    expires: Date.now() + tokens.expiresIn * 1000,
    idToken,
    tokenEndpoint,
    clientId,
    organizationId,
    workspaceId,
  };
}

/** Vibe sends the id token plus `x-external-*` tenant headers (le-vibe `_resolve_oidc_credential`). */
export function vibeOAuthToAuth(credential: OAuthCredential): ModelAuth {
  const idToken = asString(credential.idToken);
  return {
    apiKey: idToken ?? credential.access,
    ...(oidcTenantHeaders(credential) ?? {}),
  };
}

export const vibeOAuth: OAuthAuth = {
  name: "Mistral Vibe (account)",
  isSubscription: true,
  loginLabel: "Sign in with your Mistral account",
  login: loginVibeAccount,
  refresh: refreshVibeAccount,
  toAuth: async (credential) => vibeOAuthToAuth(credential),
};
