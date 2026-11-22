# pi-vibe

Standalone **Mistral Vibe (`vibe`)** provider extension for [Pi Coding Agent](https://pi.dev) — TypeScript port of the `vibe` provider block from [le-vibe](https://github.com/amirulaliffcherahim/le-vibe) (`python/le_vibe/providers/`), with no Python runtime and no `vibe` CLI process.

---

## What it does

- Registers provider **`vibe`** (display name **Mistral Vibe**) in `/model`, `/login`, `/logout`.
- Speaks pi's native `mistral-conversations` API against `https://api.mistral.ai` — streaming, tool calls, thinking levels and usage/cost accounting come from pi itself, so there is no second SSE parser to keep in sync.
- **Live model catalog only.** `getModels()` is empty until `GET /v1/model-catalog?surface=vibe-code` answers, exactly like le-vibe: no hardcoded ids. The fetched catalog is persisted through pi's model store so offline starts still list the last known models.
- **Reuses le-vibe's credentials** instead of asking for a new one:

  | Order | Source |
  |---|---|
  | 1 | pi's own `/login vibe` credential (`~/.pi/agent/auth.json`) |
  | 2 | `MISTRAL_API_KEY` env var |
  | 3 | `~/.le-vibe/auth.json` → `vibe.key` (Vibe sign-in api key) |
  | 4 | `~/.le-vibe/auth.json` → unexpired `vibe.access_token` (OIDC) |

  `LE_VIBE_AUTH_FILE` overrides the le-vibe auth path.
- Catalog row mapping is a port of le-vibe `_fetch_vibe_catalog` / `_VIBE_COMPAT`: label → name (first row wins for paid/free duplicates), `max_context_length` → context window, `parameters.reasoning` → `thinkingLevelMap` (`none` → pi `off`), `capabilities.vision` → image input, flat Vibe pricing (`0.40 / 2.00 / 0.04` per M tokens), 64k output cap, `supportsMidConvoSystemMessages`.

### Known gaps vs le-vibe

- **OS keyring** (`ai.mistral.vibe`, `ai.mistral.meow`, `vibe` services) is not read: Node has no portable Windows Credential Manager reader. Run `le-vibe login --provider vibe` once (writes `~/.le-vibe/auth.json`) or set `MISTRAL_API_KEY`.
- **OIDC refresh** is not implemented — only unexpired `access_token`s are used. Vibe sign-in currently stores an api key, so this rarely matters.

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

In the TUI: `/model` → **Mistral Vibe** → pick a live model. `/login vibe` stores a Mistral API key under pi's `vibe` provider if you do not want to share le-vibe's file.

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
├── auth.ts      # le-vibe → pi credential chain + /login implementation
└── catalog.ts   # /v1/model-catalog parsing (thinking levels, vision, pricing)
```

## License

MIT
