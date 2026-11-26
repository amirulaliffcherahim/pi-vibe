import type { Model, ProviderHeaders, ThinkingLevelMap } from "@earendil-works/pi-ai/compat";

export const VIBE_BASE_URL = "https://api.mistral.ai";
export const VIBE_USER_AGENT = "pi-vibe/1.0.0";

export type VibeChatModel = Model<"mistral-conversations">;

const CATALOG_PATH = "/v1/model-catalog?surface=vibe-code";
const DEFAULT_CONTEXT_WINDOW = 256_000;
const VIBE_MAX_TOKENS = 64_000;

/** Vibe plan pricing is flat across the catalog (mirrors le-vibe `providers/catalog.py`). */
const VIBE_COST = { input: 0.4, output: 2.0, cacheRead: 0.04, cacheWrite: 0 };

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function buildThinkingLevelMap(levels: readonly string[]): ThinkingLevelMap | undefined {
  if (levels.length === 0) return undefined;
  const offered = new Set(levels);
  const map: ThinkingLevelMap = {
    // Vibe reports "none" for the non-reasoning level; pi's "off" maps onto it.
    off: offered.has("none") ? "none" : offered.has("off") ? "off" : null,
  };
  for (const level of PI_THINKING_LEVELS) {
    map[level] = offered.has(level) ? level : null;
  }
  return map;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Port of le-vibe `_fetch_vibe_catalog` mapping: label as name, first row wins for
 * duplicate labels (paid/free variants), context from `max_context_length`,
 * reasoning from `parameters.reasoning`, image input from `capabilities.vision`.
 */
export function parseVibeCatalog(
  payload: unknown,
  providerId: string,
  baseUrl: string = VIBE_BASE_URL,
): VibeChatModel[] {
  const rows = asRecord(payload).models;
  if (!Array.isArray(rows)) return [];

  const models: VibeChatModel[] = [];
  const seenLabels = new Set<string>();
  for (const row of rows) {
    const entry = asRecord(row);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id;
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);

    const parameters = asRecord(entry.parameters);
    const levels = Array.isArray(parameters.reasoning)
      ? parameters.reasoning.filter((level): level is string => typeof level === "string")
      : [];
    const contextWindow = Number(entry.max_context_length);
    const thinkingLevelMap = buildThinkingLevelMap(levels);
    const vision = asRecord(entry.capabilities).vision === true;

    models.push({
      type: "chat",
      id,
      name: label,
      provider: providerId,
      api: "mistral-conversations",
      baseUrl,
      reasoning: levels.length > 0,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: vision ? ["text", "image"] : ["text"],
      cost: { ...VIBE_COST },
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
      maxTokens: VIBE_MAX_TOKENS,
      compat: { supportsMidConvoSystemMessages: true },
    });
  }
  return models;
}

export async function fetchVibeCatalog(
  apiKey: string,
  signal: AbortSignal,
  baseUrl: string = VIBE_BASE_URL,
  providerId = "vibe",
  extraHeaders?: ProviderHeaders,
): Promise<VibeChatModel[]> {
  const root = baseUrl.replace(/\/+$/u, "");
  // ProviderHeaders allows null to delete a header; fetch needs plain strings.
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    if (typeof value === "string") extra[name] = value;
  }
  const response = await fetch(`${root}${CATALOG_PATH}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": VIBE_USER_AGENT,
      ...extra,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Vibe model catalog failed: HTTP ${response.status} ${response.statusText}`.trim());
  }
  return parseVibeCatalog(await response.json(), providerId, baseUrl);
}
