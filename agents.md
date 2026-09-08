# AGENTS.md

## System Overview

`docker-mailserver-api` is a minimal, robust HTTP API built on Bun and Elysia to manage Docker Mailserver (DMS) instances. It provides:
1. Mail account CRUD via official `setup` commands executed in the target DMS container.
2. Direct mailbox inspection and manipulation (folders, message list, detail, flags, move/trash, attachment retrieval) using a native Dovecot master user over implicit TLS IMAP (`imapflow`).
3. Outgoing message submission using Nodemailer (`nodemailer`), authenticated via a dedicated administrator SMTP user while preserving Sent copies in the target mailbox.

## Key Security and Architectural Invariants

1. **Private Tailnet Binding Only**
   - The service must bind to an assigned Tailscale IP address in the `100.64.0.0/10` CGNAT range on an active local interface (`TAILSCALE_IP`).
   - Binding fails closed if the IP is absent, unassigned, or not in the CGNAT block.
   - The API is never exposed to the public internet or bound to universal wildcards (`0.0.0.0`).

2. **Bearer Token Authentication & Constant-Time Verification**
   - Every request (including `/health`) requires `Authorization: Bearer <ADMIN_API_TOKEN>`.
   - Token validation uses `node:crypto` `timingSafeEqual` after length comparison to prevent timing side-channel attacks.
   - Unauthenticated `OPTIONS` requests are strictly restricted to exact pre-configured `CORS_ORIGINS`.

3. **No Password Storage or Database**
   - The API maintains no local database, credential store, or hash table.
   - Mailbox access is enabled by a single Dovecot master user (`user@domain*masterUser` login).
   - Upstream DMS account creation and password updates pipe passwords directly to `setup` CLI stdin without argv exposure or persistence.

4. **Account Purge Protection**
   - Account deletion requires explicit JSON confirmation `{ "confirmEmail": "<exact normalized email>", "purge": true }`.
   - Deletion of the configured `SMTP_USER` is strictly rejected with `409 CONFLICT` to avoid operator lockout.
   - If the account Maildir exists, `setup email del -y` is run; if Maildir is missing, `setup email del -n` is used.

5. **Operation Concurrency & Mutex Boundaries**
   - Global mutation mutex (`Mutex`) serializes all account additions, password modifications, and deletions.
   - Per-account mutex (`KeyedMutex`) serializes account deletion against active IMAP/SMTP message operations for that specific account.
   - Active concurrent mail operations are bounded to 4 across the process; excess requests immediately receive `503 BUSY`.

6. **Spoof Protection & Unionmap Delegation**
   - Administrator outbound authority is provisioned in Postfix via `smtpd_sender_login_maps` using a PCRE unionmap with `SPOOF_PROTECTION=1`.
   - Generic open relay or disabling spoof protection is forbidden.

7. **Error Masking & Safe Payloads**
   - All errors follow `{ "error": { "code": "<CODE>", "message": "<SAFE_MESSAGE>" } }`.
   - Raw stack traces, Elysia validation schema errors, and upstream subprocess/IMAP/SMTP messages are never leaked.

## Commands

- `bun run check`: Runs Biome linter, TypeScript typecheck, and unit test suite.
- `bun run test`: Runs unit and behavioral test suite (`bun test test`).
- `bun run lint`: Runs Biome check.
- `bun run format`: Runs Biome auto-formatting.
- `bun run typecheck`: Runs TypeScript compiler (`tsc --noEmit`).
- `bun run smoke`: Runs end-to-end integration tests with Docker Mailserver fixture.
