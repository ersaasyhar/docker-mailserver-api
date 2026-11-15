# Docker Mailserver Admin API

A lightweight, secure, and production-ready HTTP REST API built on **Bun** and **Elysia** to manage [Docker Mailserver (DMS)](https://github.com/docker-mailserver/docker-mailserver).

Designed for single-administrator mail management backends, it allows an operator or admin dashboard to perform mailbox CRUD operations and inspect/read/update/trash/archive/send emails across all managed mailboxes without ever storing or handling individual user passwords.

---

## Architecture & Security Highlights

1. **Tailnet Private Binding Only**:
   The service requires and validates that `TAILSCALE_IP` is a valid IPv4 address in the `100.64.0.0/10` CGNAT range assigned to a local interface. It fails closed on absent or invalid interfaces, refusing public internet exposure.
2. **Timing-Safe Bearer Token Authentication**:
   Every request is authenticated via `Authorization: Bearer <ADMIN_API_TOKEN>` using `crypto.timingSafeEqual` to eliminate timing side-channel attacks.
3. **No Password Storage**:
   The API maintains zero databases and stores no credentials. Mailbox operations utilize a native Dovecot master account (`user@domain*masterUser`).
4. **Postfix Spoof Protection & Sender Authority**:
   Maintains `SPOOF_PROTECTION=1` while granting the administrator account permission to submit mail as any managed mailbox using a Postfix PCRE unionmap.
5. **Irreversible Purge Safeguards**:
   Deleting an account requires explicit JSON confirmation `{ "confirmEmail": "<email>", "purge": true }`. The active `SMTP_USER` cannot be deleted.
6. **Docker Host Root-Equivalent Privilege Warning**:
   The service executes Docker CLI commands (`setup email ...`) on the host. In Docker architecture, membership in the `docker` group is root-equivalent on the host. Restrict access strictly to trusted operators via Tailscale and secure systemd isolation.
7. **Frontend Data Isolation**:
   Flags, folder names, and message HTML are untrusted user input. Frontend dashboards must sanitize HTML and use sandboxed iframes (`sandbox="allow-same-origin"`) rather than injecting HTML directly into dashboard DOM.

---

## Environment Configuration Table

All variables can be defined in `.env` or systemd environment files (mode `0600`).

| Variable | Type / Default | Description |
| :--- | :--- | :--- |
| `TAILSCALE_IP` | **Required** (IPv4) | Dedicated Tailscale IPv4 address in `100.64.0.0/10` present on a local network interface. |
| `PORT` | `3000` (1..65535) | Port to bind and listen on. |
| `ADMIN_API_TOKEN` | **Required** (String >= 32B) | Secret API bearer token. |
| `MAIL_DOMAINS` | **Required** (CSV) | Comma-separated lowercase DNS domains (e.g. `korintus.me`). |
| `DMS_CONTAINER` | **Required** (String) | Name of target Docker Mailserver container. |
| `IMAP_HOST` | `127.0.0.1` | Hostname or IP of DMS IMAP daemon. |
| `IMAP_PORT` | `993` | IMAP port (uses implicit TLS). |
| `IMAP_MASTER_USER` | **Required** (String) | Dovecot master username (e.g. `mail-api`). |
| `IMAP_MASTER_PASSWORD`| **Required** (String) | Dovecot master password. |
| `SMTP_HOST` | `127.0.0.1` | Hostname or IP of DMS SMTP daemon. |
| `SMTP_PORT` | `587` | SMTP submission port (uses mandatory STARTTLS). |
| `SMTP_USER` | **Required** (String) | Admin mailbox used to authenticate outgoing mail submission (e.g. `admin@korintus.me`). |
| `SMTP_PASSWORD` | **Required** (String) | Password for `SMTP_USER`. |
| `MAIL_TLS_SERVERNAME` | **Required** (String) | Servername matching the TLS certificate presented by IMAP and SMTP (e.g. `mail.korintus.me`). |
| `MAIL_TLS_CA_FILE` | *Optional* (Path) | Path to custom CA certificate file if using private/internal PKI. |
| `CORS_ORIGINS` | *Optional* (CSV) | Allowed exact HTTP(S) origins (e.g. `https://mail-admin.korintus.me`). Wildcards and `null` are rejected. |

---

## Operator DMS Preflight & Configuration

### 1. Verify DMS Version and FILE Provisioner
Inspect your container setup help:
```bash
docker exec <container> setup help
```
Confirm the container is using the FILE provisioner (default). Note that database provisioners (LDAP, MySQL/PostgreSQL) are not managed by this release.

### 2. Configure Dovecot Master User
On the host running the DMS container, execute:
```bash
docker exec -it <container> setup dovecot-master add mail-api
```
Enter a secure password when prompted. DMS detects this file and configures master authentication. If needed, restart the container:
```bash
docker restart <container>
```

### 3. Configure Postfix Admin Sender Unionmap
To allow `admin@korintus.me` to send on behalf of any address in `korintus.me` without disabling spoof protection:

1. Create `postfix-admin-senders.pcre` in your DMS configuration directory (e.g. `docker-data/dms/config/postfix-admin-senders.pcre`):
   ```pcre
   /^([^@]+@korintus\.me)$/ ${1}, admin@korintus.me
   ```
2. In `postfix-main.cf` in the DMS config directory, configure `smtpd_sender_login_maps` using a unionmap:
   ```cf
   smtpd_sender_login_maps = unionmap:{ pcre:/tmp/docker-mailserver/postfix-admin-senders.pcre, texthash:/etc/postfix/virtual, hash:/etc/aliases, pcre:/etc/postfix/maps/sender_login_maps.pcre }
   ```
   *(If your setup has existing sender maps, preserve those entries within the `unionmap:{...}` block).*
3. Reload or restart DMS to apply the Postfix configuration.

---

## API Endpoints Reference

Mail and health operations require `Authorization: Bearer <ADMIN_API_TOKEN>`. Path parameters for emails must be URL-encoded (e.g. `user%40korintus.me`).

Static discovery is public within the network boundary: [`/llms.txt`](/llms.txt), [`/docs`](/docs), and [`/docs/openapi.json`](/docs/openapi.json). The canonical files are [agent usage](docs/agent-usage.md), [OpenAPI](docs/openapi.json), and [discovery](docs/llms.txt).

### Health & Liveness
- **`GET /health`**
  - **Response 200**: `{"status": "ok"}`

### Accounts (`/v1/accounts`)

- **`GET /v1/accounts`**
  - Returns all managed mailboxes sorted alphabetically.
  - **Response 200**:
    ```json
    {
      "items": [
        { "email": "admin@korintus.me" },
        { "email": "user@korintus.me" }
      ]
    }
    ```

- **`POST /v1/accounts`**
  - Provision a new mailbox profile. Passwords must be 12..256 bytes without control characters.
  - **Request Body**:
    ```json
    {
      "email": "alice@korintus.me",
      "password": "SecurePassword123!"
    }
    ```
  - **Response 201**:
    ```json
    {
      "email": "alice@korintus.me",
      "provisioning": "pending"
    }
    ```

- **`GET /v1/accounts/:email`**
  - **Response 200**: `{"email": "alice@korintus.me"}`
  - **Response 404**: Account not found.

- **`PATCH /v1/accounts/:email`**
  - Update account password.
  - **Request Body**: `{"password": "NewSecurePassword123!"}`
  - **Response 200**: `{"email": "alice@korintus.me", "provisioning": "pending"}`

- **`DELETE /v1/accounts/:email`**
  - Irreversibly delete account and purge mailbox storage.
  - **Request Body**:
    ```json
    {
      "confirmEmail": "alice@korintus.me",
      "purge": true
    }
    ```
  - **Response 204**: No content.

---

### Mailboxes & Messages (`/v1/accounts/:email/...`)

- **`GET /v1/accounts/:email/folders`**
  - List available IMAP folders.
  - **Response 200**:
    ```json
    {
      "items": [
        { "path": "INBOX", "name": "INBOX" },
        { "path": "Archive", "name": "Archive", "specialUse": "\\Archive" },
        { "path": "Trash", "name": "Trash", "specialUse": "\\Trash" },
        { "path": "Sent", "name": "Sent", "specialUse": "\\Sent" }
      ]
    }
    ```

- **`GET /v1/accounts/:email/messages?folder=INBOX&limit=50&beforeUid=100&uidValidity=12345`**
  - List message summaries in descending UID order.
  - On cursor-based pagination, `beforeUid` requires matching `uidValidity`.
  - **Response 200**:
    ```json
    {
      "folder": "INBOX",
      "uidValidity": "12345",
      "items": [
        {
          "uid": 99,
          "flags": ["\\Seen"],
          "from": { "name": "Alice", "address": "alice@example.com" },
          "to": [{ "name": "Me", "address": "user@korintus.me" }],
          "subject": "Status Report",
          "date": "2026-09-08T12:00:00.000Z",
          "size": 2450
        }
      ],
      "nextBeforeUid": 99
    }
    ```

- **`GET /v1/messages/latest`**
  - Scans all managed INBOXes by IMAP receipt time and returns the full message with receiving `account` and `receivedAt`, or bodyless 204 when all are empty. The sequential scan is not a snapshot; see the [agent guide](docs/agent-usage.md).

- **`GET /v1/accounts/:email/messages/latest?folder=INBOX`**
  - Returns the highest-UID full message without marking it seen, or bodyless 204 when the folder is empty.

- **`GET /v1/accounts/:email/messages/:uid?folder=INBOX&uidValidity=12345`**
  - Fetch parsed message details without marking it as seen.
  - **Response 200**:
    ```json
    {
      "uid": 99,
      "uidValidity": "12345",
      "folder": "INBOX",
      "flags": ["\\Seen"],
      "from": { "name": "Alice", "address": "alice@example.com" },
      "to": [{ "name": "Me", "address": "user@korintus.me" }],
      "cc": [],
      "subject": "Status Report",
      "date": "2026-09-08T12:00:00.000Z",
      "text": "Report contents...",
      "html": "<p>Report contents...</p>",
      "attachments": [
        {
          "index": 0,
          "filename": "report.pdf",
          "mimeType": "application/pdf",
          "size": 104857,
          "contentId": null
        }
      ]
    }
    ```

- **`GET /v1/accounts/:email/messages/:uid/attachments/:index?folder=INBOX&uidValidity=12345`**
  - Downloads raw binary attachment with `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename="..."`.

- **`PATCH /v1/accounts/:email/messages/:uid?folder=INBOX&uidValidity=12345`**
  - Modify `\Seen` and `\Flagged` flags while preserving custom or other existing flags.
  - **Request Body**: `{"seen": true, "flagged": false}`
  - **Response 200**:
    ```json
    {
      "uid": 99,
      "uidValidity": "12345",
      "folder": "INBOX",
      "flags": ["\\Seen", "$Custom"]
    }
    ```

- **`POST /v1/accounts/:email/messages/:uid/move?folder=INBOX&uidValidity=12345`**
  - Move message to special-use Archive or Trash folder.
  - **Request Body**: `{"destination": "archive"}` or `{"destination": "trash"}`
  - **Response 200**: `{"moved": true, "destination": "Archive"}`

- **`DELETE /v1/accounts/:email/messages/:uid?folder=INBOX&uidValidity=12345`**
  - Moves message to Trash (idempotent; 204 if already in Trash).
  - **Response 204**: No content.

- **`POST /v1/accounts/:email/messages/send`**
  - Compose and submit an outgoing email via authenticated SMTP with STARTTLS and append a copy to the sender's `Sent` mailbox.
  - **Request Body**:
    ```json
    {
      "to": ["partner@example.com"],
      "cc": ["team@korintus.me"],
      "bcc": ["archive@korintus.me"],
      "subject": "Project Kickoff",
      "text": "Hello Team!",
      "html": "<p>Hello <b>Team</b>!</p>",
      "attachments": [
        {
          "filename": "specs.txt",
          "contentType": "text/plain",
          "contentBase64": "SGVsbG8gV29ybGQ="
        }
      ]
    }
    ```
  - **Response 200**:
    ```json
    {
      "messageId": "<abcd-1234@korintus.me>",
      "accepted": ["partner@example.com", "team@korintus.me", "archive@korintus.me"],
      "rejected": [],
      "sentCopySaved": true
    }
    ```
  *(Note: Return indicates SMTP server acceptance, not final delivery to external MX records).*

---

## Deployment on Ubuntu via Systemd

1. **Prerequisites**:
   Ensure Bun is installed on the host. Obtain the binary path using:
   ```bash
   command -v bun
   ```
   *(If Bun was installed under a user home directory, substitute that exact binary path into `ExecStart` and ensure the service user has directory traversal/execution permissions).*

2. **Create Service User & Group**:
   ```bash
   sudo useradd --system --shell /usr/sbin/nologin --create-home --home-dir /opt/docker-mailserver-api mail-api
   sudo usermod -aG docker mail-api
   ```

3. **Deploy Code & Dependencies**:
   ```bash
   sudo cp -r . /opt/docker-mailserver-api
   sudo chown -R mail-api:mail-api /opt/docker-mailserver-api
   ```

4. **Install Environment File**:
   Copy `.env.example` to `/etc/docker-mailserver-api.env`:
   ```bash
   sudo cp .env.example /etc/docker-mailserver-api.env
   sudo chown root:mail-api /etc/docker-mailserver-api.env
   sudo chmod 0600 /etc/docker-mailserver-api.env
   ```
   Edit `/etc/docker-mailserver-api.env` with your production Tailscale IP, tokens, and credentials.

5. **Install Systemd Unit**:
   ```bash
   sudo cp deploy/docker-mailserver-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now docker-mailserver-api.service
   ```

6. **Verify Status & Logs**:
   ```bash
   sudo systemctl status docker-mailserver-api.service
   sudo journalctl -u docker-mailserver-api.service -f
   ```

---

## Development & Local Checks

Install dependencies and set up git hooks:
```bash
bun install
bun run prepare
```

Run comprehensive check suite (Biome lint, TypeScript typecheck, unit tests):
```bash
bun run check
```

Run end-to-end integration test against Docker Mailserver fixture:
```bash
bun run smoke
```

---

## License

This project is licensed under the [MIT License](LICENSE).
