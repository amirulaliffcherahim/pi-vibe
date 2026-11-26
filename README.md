# pi-vibe

Standalone **Mistral Vibe (`vibe`)** provider extension for [Pi Coding Agent](https://pi.dev) — TypeScript port of the `vibe` provider block from [le-vibe](https://github.com/amirulaliffcherahim/le-vibe) (`python/le_vibe/providers/`), with no Python runtime and no `vibe` CLI process.

---

## What it does

- Registers provider **`vibe`** (display name **Mistral Vibe**) in `/model`, `/login`, `/logout`.
- Speaks pi's native `mistral-conversations` API against `https://api.mistral.ai` — streaming, tool calls, thinking levels and usage/cost accounting come from pi itself, so there is no second SSE parser to keep in sync.
- **Live model catalog only.** `getModels()` is empty until `GET /v1/model-catalog?surface=vibe-code` answers, exactly like le-vibe: no hardcoded ids. The fetched catalog is persisted through pi's model store so offline starts still list the last known models.
- **Two login methods**, so `/login vibe` offers both “Sign in with your Mistral account” and “Sign in with an API key”:
  1. **Account** — the Vibe CLI's browser sign-in (`console.mistral.ai/api/vibe/sign-in`): pi starts a PKCE process, opens the console page, waits for you to approve in the browser, then exchanges the signed verifier for a Vibe API key. No key is typed or copied. Stored by pi in `~/.pi/agent/auth.json` under `vibe` (`type: oauth`), renewed locally by extending the stored expiry.
  2. **API key** — password prompt only. Ambient sources (`MISTRAL_API_KEY`, `~/.le-vibe/auth.json`) are deliberately ignored so the provider is never reported as “API key configured” before you choose that method.
- **OIDC is not used**: `auth.mistral.ai` answers `invalid_client` for the Vibe CLI client id from this machine, so the earlier OIDC PKCE path was replaced by the browser sign-in above.
- **Live catalog at login**: `fetchModels` uses whichever credential you logged in with; sign-in triggers pi's post-login catalog refresh (6 models at the time of writing: `mistral-large-4-0`, `mistral-medium-latest`, `zai-glm-5-3`, `zai-glm-5-3-flash`, `zai-glm-5-3-flash-vibe-free`, `deepseek-v4-1-flash-1017`).
- Catalog row mapping is a port of le-vibe `_fetch_vibe_catalog` / `_VIBE_COMPAT`: label → name (first row wins for paid/free duplicates), `max_context_length` → context window, `parameters.reasoning` → `thinkingLevelMap` (`none` → pi `off`), `capabilities.vision` → image input, flat Vibe pricing (`0.40 / 2.00 / 0.04` per M tokens), 64k output cap, `supportsMidConvoSystemMessages`.

### Known gaps

- **OS keyring** (`ai.mistral.vibe`, `ai.mistral.meow`) is not read: Node has no portable Windows Credential Manager reader. `/login vibe` writes its own credential instead.
- **le-vibe's `~/.le-vibe/auth.json` is no longer consulted** — deliberately, so an old sign-in key can't silently act as your credential. Log in once with `/login vibe`.
- `/vibe` shows the registration state, the auth method in use (`oauth` or `api_key`) and the live catalog count.

---

## Installation

```bash
pi install git:github.com/amirulaliffcherahim/pi-vibe
```

or add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["git:github.com/amirulaliffcherahim/pi-vibe"] }
```

## Usage

```bash
pi --model vibe-mistral-large-4-0     # anything the live catalog returns
pi --list-models | grep vibe
```

In the TUI: `/model` → **Mistral Vibe** → pick a live model. Sign in once with `/login vibe` → **Sign in with your Mistral account**: the browser opens the console page, you approve, and pi stores the resulting Vibe credential under `vibe`.

Optional overrides via `~/.pi/agent/models.json` (kept above the extension):

```json
{
  "providers": {
    "vibe": {
      "modelOverrides": {
        "mistral-large-4-0": { "cost": { "input": 0.4, "output": 2, "cacheRead": 0.04, "cacheWrite": 0 } }
      }
    }
  }
}
```

## Layout

```text
src/
├── index.ts     # createProvider({ id: "vibe", api: mistralConversationsApi(), fetchModels })
├── auth.ts      # /login vibe API-key method (stored credential only)
├── oauth.ts     # /login vibe account method: console.mistral.ai browser sign-in → Vibe API key
└── catalog.ts   # /v1/model-catalog parsing (thinking levels, vision, pricing)
```

## License

MIT
