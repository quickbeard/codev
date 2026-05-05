# Supabase Upload Integration

## Problem

CoDev could already collect coding-agent conversations locally through `codev export`, writing Markdown logs and session statistics under `~/.codev/logs/<project>/`. However, those logs stayed on the developer machine, so the AI Hub web application could not ingest them into Supabase or expose usage analytics in dashboards and reports.

The existing login path also used the legacy `sso-wrapper` token and then exchanged it through `codev-proxy/auth/exchange` for an AI gateway key. That flow was not compatible with the Supabase upload APIs, which require a Supabase-authenticated JWT.

## Solution

This change adds a Supabase-backed upload path:

- `codev upload` exports current project conversations and uploads new or changed Markdown logs.
- `codev upload --skip-export` uploads existing exported logs without re-exporting.
- Supabase config is read from `CODEV_SUPABASE_URL` and `CODEV_SUPABASE_ANON_KEY`, with `.env.example` documenting the required variables.
- CLI login now authenticates through Supabase PKCE using the custom provider `custom:vtnet-oidc`.
- The install SSO path now uses the Supabase access token directly, avoiding the old proxy exchange that rejected Supabase tokens.
- Uploads use the existing AI Hub web ingestion flow:
  1. scan `~/.codev/logs/<project>/{claude-code,codex,opencode}/*.md`
  2. hash each file with SHA-256
  3. query `conversations` for existing `local_file_path` + `local_content_hash`
  4. call `presign-upload`
  5. gzip and PUT the Markdown file to the signed URL
  6. call `confirm-upload` with file metadata and dedup fields

## Supabase Setup Notes

The Supabase custom OIDC provider must be configured with the callback URL shown in Supabase:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

The CLI loopback callback should be allowed in Supabase Auth redirect URLs:

```text
http://127.0.0.1:*/callback
http://localhost:*/callback
```

Do not pass a custom OAuth `state` or `nonce` from the CLI to Supabase. Supabase GoTrue manages upstream OAuth state for custom providers; overriding it causes `bad_auth_state` errors.

## Validation

The implementation is covered by auth, upload, login component, and install flow tests. The expected validation commands are:

```sh
bun run fix
bun run typecheck
bun test
bun run build
```
