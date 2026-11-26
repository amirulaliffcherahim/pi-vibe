import { createHash, randomBytes } from "node:crypto";
import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai/compat";

/**
 * Mistral Vibe account sign-in, ported from the Vibe CLI's browser sign-in gateway
 * (`vibe/setup/auth/browser_sign_in.py`): start a process, open the console page,
 * poll until the browser finishes, then exchange the signed PKCE verifier for a
 * Vibe API key. No API key is ever typed or copied.
 *
 * The OIDC client (`auth.mistral.ai`, client `829da7e7-…`) is *not* used: Mistral
 * answers `invalid_client` for it, so only this flow is implemented.
 */
export const VIBE_CONSOLE_ORIGIN = "https://console.mistral.ai";
const SIGN_IN_API_BASE = `${VIBE_CONSOLE_ORIGIN}/api`;
const POLL_INTERVAL_MS = 3_000;
/** Console rate-limits polling (HTTP 429); back off instead of failing the attempt. */
const MAX_CONSECUTIVE_POLL_FAILURES = 8;
/** Sign-in returns a long-lived Vibe API key; the stored expiry is renewed on refresh. */
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

interface SignInProcess {
  processId: string;
  signInUrl: string;
  pollUrl: string;
  expiresAt: number;
}

interface PollResult {
  status: "pending" | "completed" | "expired" | "denied" | "error";
  exchangeToken?: string;
  message?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The server hands back the browser URLs; they must stay on the console origin. */
function assertConsoleUrl(value: string, signal: AbortSignal): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Vibe sign-in returned an invalid URL");
  }
  if (url.origin !== VIBE_CONSOLE_ORIGIN) {
    throw new Error(`Vibe sign-in returned a URL outside ${VIBE_CONSOLE_ORIGIN}`);
  }
  signal.throwIfAborted();
  return url.toString();
}

function pkcePair(): { verifier: string; challenge: string } {
  const base64Url = (buffer: Buffer): string =>
    buffer.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = asString(payload.message) ?? asString(payload.error) ?? text.slice(0, 200);
    throw new Error(`${label} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`.trim());
  }
  return payload;
}

async function startSignIn(signal: AbortSignal): Promise<SignInProcess & { verifier: string }> {
  const { verifier, challenge } = pkcePair();
  const response = await fetch(`${SIGN_IN_API_BASE}/vibe/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
    signal,
  });
  const payload = await readJson(response, "Vibe sign-in start");
  const processId = asString(payload.process_id);
  const signInUrl = asString(payload.sign_in_url);
  const pollUrl = asString(payload.poll_url);
  if (!processId || !signInUrl || !pollUrl) {
    throw new Error("Vibe sign-in start response is missing process_id/sign_in_url/poll_url");
  }
  const expiresAt = Date.parse(asString(payload.expires_at) ?? "");
  return {
    processId,
    signInUrl: assertConsoleUrl(signInUrl, signal),
    pollUrl: assertConsoleUrl(pollUrl, signal),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60 * 1_000,
    verifier,
  };
}

async function pollSignIn(pollUrl: string, signal: AbortSignal): Promise<PollResult> {
  const response = await fetch(pollUrl, { headers: { Accept: "application/json" }, signal });
  if (response.status === 410) return { status: "expired" };
  const payload = await readJson(response, "Vibe sign-in poll");
  const status = asString(payload.status);
  if (status !== "pending" && status !== "completed" && status !== "expired" && status !== "denied" && status !== "error") {
    throw new Error(`Vibe sign-in returned an unknown state: ${status ?? "missing"}`);
  }
  return {
    status,
    exchangeToken: asString(payload.exchange_token),
    message: asString(payload.message),
  };
}

async function exchangeForApiKey(
  process: SignInProcess & { verifier: string },
  exchangeToken: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${SIGN_IN_API_BASE}/vibe/sign-in/${encodeURIComponent(process.processId)}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: process.verifier }),
    signal,
  });
  const payload = await readJson(response, "Vibe sign-in exchange");
  const apiKey = asString(payload.api_key);
  if (!apiKey) throw new Error("Vibe sign-in exchange did not return an API key");
  return apiKey;
}

async function waitForSignIn(process: SignInProcess, signal: AbortSignal): Promise<string> {
  let failures = 0;
  while (Date.now() < process.expiresAt) {
    signal.throwIfAborted();
    let result: PollResult;
    try {
      result = await pollSignIn(process.pollUrl, signal);
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      await sleep(pollDelay(process, failures), signal);
      continue;
    }
    if (result.status === "completed") {
      if (!result.exchangeToken) throw new Error("Vibe sign-in completed without an exchange token");
      return result.exchangeToken;
    }
    if (result.status === "expired") throw new Error("Vibe sign-in expired; run /login vibe again");
    if (result.status === "denied") throw new Error("Vibe sign-in was denied");
    if (result.status === "error") throw new Error(result.message ?? "Vibe sign-in failed");
    await sleep(pollDelay(process, 0), signal);
  }
  throw new Error("Vibe sign-in timed out; run /login vibe again");
}

function pollDelay(process: SignInProcess, failures: number): number {
  const backoff = POLL_INTERVAL_MS * Math.min(2 ** Math.max(0, failures - 1), 5);
  return Math.min(backoff, Math.max(0, process.expiresAt - Date.now()));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Vibe sign-in cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function loginVibeAccount(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const process = await startSignIn(interaction.signal);
  interaction.notify({
    type: "auth_url",
    url: process.signInUrl,
    instructions:
      "Sign in to Mistral in your browser and pick the workspace for Vibe. pi finishes on its own when the browser is done.",
  });
  const exchangeToken = await waitForSignIn(process, interaction.signal);
  interaction.notify({ type: "progress", message: "Exchanging browser sign-in for a Vibe credential…" });
  const apiKey = await exchangeForApiKey(process, exchangeToken, interaction.signal);
  return {
    type: "oauth",
    access: apiKey,
    refresh: apiKey,
    expires: Date.now() + CREDENTIAL_TTL_MS,
    apiKey,
  };
}

/** The sign-in credential is a long-lived Vibe API key: renew the stored expiry, never network. */
export async function refreshVibeAccount(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const apiKey = asString(credential.apiKey) ?? asString(credential.access);
  if (!apiKey) throw new Error("Mistral Vibe credential has no API key; run /login vibe again");
  return { ...credential, type: "oauth", access: apiKey, refresh: apiKey, expires: Date.now() + CREDENTIAL_TTL_MS };
}

export function vibeOAuthToAuth(credential: OAuthCredential): ModelAuth {
  const apiKey = asString(credential.apiKey) ?? asString(credential.access);
  if (!apiKey) throw new Error("Mistral Vibe credential has no API key; run /login vibe again");
  return { apiKey };
}

export const vibeOAuth: OAuthAuth = {
  name: "Mistral Vibe (account)",
  isSubscription: true,
  loginLabel: "Sign in with your Mistral account",
  login: loginVibeAccount,
  refresh: refreshVibeAccount,
  toAuth: async (credential) => vibeOAuthToAuth(credential),
};
