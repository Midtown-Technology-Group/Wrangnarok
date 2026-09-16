---
name: keeper-vault
description: Read narrowly-scoped credentials from Keeper Vault via the local Commander REST service for scripts and lanes. Use when a task needs a named secret (API tokens, connection strings) without ever printing values.
---

# Keeper Vault (narrowly-scoped credential access)

Read secrets by friendly name. Never print, log, echo, or embed values —
verify by metadata (length, format class, downstream auth success) only.

## Locate (no values touched)

- Friendly-name map: `C:\Users\ThomasBray\.codex\keeper-secret-map.json`
  (`name` → Keeper `uid` + `field`). The map holds NO secret values.
- Pick the least-privilege record for the job (read-only over root,
  scoped over global). If none fits, stop and ask the human.

## Talk to the REST service

- Base: `http://127.0.0.1:9009`, endpoint `POST /api/v1/executecommand`.
- Auth: header `api-key` = contents of
  `C:\Users\ThomasBray\.codex\keeper-service\api-key.txt` (read file,
  never print). If 401: service auth expired — human runs `keeper login`
  with `KEEPER_DATA_HOME=$env:USERPROFILE\.codex\keeper-service`, or the
  api-key file rotated; do not guess.
- Body is JSON `{"command": "<commander command>"}`. Allowed commands are
  service-configured (typically `get,search,version,login-status`).
  Discover shape first: `search "<name>" --format json` returns records
  (uid/title/type only). Then `get <uid> --format json`.
- Response envelope: `{status, command, data}`. Record fields live at
  `.data.fields[]` with `{type, label, value}` where `value` is a
  single-element array — unwrap `[0]`.
- Verify shape without leaking: report `type`, char-length, and
  character class only. Never report substrings of a credential value —
  not even first/last characters. Then use immediately (Authorization
  header, secret-put stdin) and drop the variable. Never write values to
  repo files, issue bodies, chat-visible logs, or temp files you leave behind.

## Worked example (read-only token check)

```powershell
$key = (Get-Content "$env:USERPROFILE\.codex\keeper-service\api-key.txt" -Raw).Trim()
$do = { param($cmd) $b = @{ command = $cmd } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri 'http://127.0.0.1:9009/api/v1/executecommand' `
    -Method Post -Headers @{ 'api-key' = $key } `
    -ContentType 'application/json' -Body $b -TimeoutSec 60 }
$hit = (& $do 'search "pass/cloudflare/mtg-account-token-readall" --format json').data |
  Where-Object { $_.name -eq 'pass/cloudflare/mtg-account-token-readall' }
$rec = & $do ("get " + $hit.uid + " --format json")
$tok = ($rec.data.fields | Where-Object { $_.type -eq 'password' }).value[0]
Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
  -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 20
```

## Boundaries

- Least privilege always: read-only tokens for inspection, scoped tokens
  for writes, root/global keys never unless the human explicitly names them
  for the job.
- The map file may gain entries (`name`, `uid`, `field`, `description`);
  it must never gain values.
- If the service is down: check port 9009, `keeper-service\service-start.log`,
  stale `.keeper\.service.env`. Restart only with the documented lane
  (`KEEPER_DATA_HOME` set, hidden/background shell).
