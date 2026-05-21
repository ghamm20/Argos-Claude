# /api/settings — GET, POST

Read or patch user settings. Settings persist to `ARGOS_ROOT/config/settings.json` via an atomic write-rename pattern (Phase W hardening).

## GET /api/settings

Reads current settings from disk. Falls back to defaults if the file doesn't exist.

```http
GET /api/settings
```

### Response: `200 OK`

```json
{
  "version": 1,
  "defaultPersona": "bartimaeus",
  "defaultModel": "llama3.1:8b-instruct-q4_K_M",
  "updatedAt": 1779323133408
}
```

`updatedAt` is `0` if the file doesn't exist on disk (first launch).

## POST /api/settings

Patch one or both default fields. Fields not in the request body are left untouched.

```http
POST /api/settings
Content-Type: application/json
```

```json
{
  "defaultPersona": "juniper",
  "defaultModel": "qwen2.5:3b-instruct-q4_K_M"
}
```

### Fields

| Field | Type | Required | Validation |
|---|---|---|---|
| `defaultPersona` | `string` | no | Must be a key in `PERSONA_BY_ID` |
| `defaultModel` | `string` | no | Must be in `AVAILABLE_MODELS` |

At least one of `defaultPersona` or `defaultModel` must be present.

### Response: `200 OK`

Returns the new settings object (same shape as GET response):

```json
{
  "version": 1,
  "defaultPersona": "juniper",
  "defaultModel": "qwen2.5:3b-instruct-q4_K_M",
  "updatedAt": 1779323456789
}
```

### Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ error: "invalid JSON body" }` | Body wasn't parseable JSON |
| `400` | `{ error: "defaultPersona must be a string" }` | Non-string field value |
| `400` | `{ error: "unknown persona: ..." }` | Persona not in `PERSONA_BY_ID` |
| `400` | `{ error: "defaultModel must be a string" }` | Non-string field value |
| `400` | `{ error: "model not in allowed list", availableModels: [...] }` | Model not in `AVAILABLE_MODELS` |
| `400` | `{ error: "no recognised fields to update" }` | Body had no `defaultPersona` or `defaultModel` |

## Persistence

`writeSettings()` in `lib/settings.ts` uses an atomic write-rename pattern (Phase W of the autonomous block):

1. Open `${settingsPath}.${pid}.tmp` for write
2. Write the full JSON payload
3. `fsync` to force the write to disk
4. Close the file handle
5. Rename `${tmp} → settings.json`

This makes settings.json crash-safe: if the process is killed or the USB is yanked mid-write, settings.json itself is either the previous valid version or the new one, never partial. The worst case is an orphaned `.tmp` file in the config dir.

## Concurrency

Single-user assumption. The API does not lock around the read-modify-write cycle. Two simultaneous POST requests racing could lose updates. Filed as v2 work if multi-tab editing becomes a real concern.
