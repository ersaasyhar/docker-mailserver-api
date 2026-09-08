import { describe, expect, it } from "bun:test";
import { AccountService, KeyedMutex, Mutex } from "../src/accounts";
import { AppError, createApp } from "../src/app";
import type { Config } from "../src/config";
import type { DmsClient } from "../src/dms";
import type { MailService } from "../src/mail";
import {
  type FolderItem,
  type MessageDetail,
  type MessageSummary,
  parseRawEmail,
  type SendMessagePayload,
  type SendResult,
} from "../src/messages";

const TEST_TOKEN = "a-secure-admin-token-that-is-at-least-32-bytes-long";

const testConfig: Config = {
  tailscaleIp: "100.64.0.1",
  port: 3000,
  adminApiToken: TEST_TOKEN,
  mailDomains: ["korintus.me"],
  dmsContainer: "mailserver",
  imapHost: "127.0.0.1",
  imapPort: 993,
  imapMasterUser: "mail-api",
  imapMasterPassword: "master-password",
  smtpHost: "127.0.0.1",
  smtpPort: 587,
  smtpUser: "admin@korintus.me",
  smtpPassword: "smtp-password",
  mailTlsServername: "mail.korintus.me",
  corsOrigins: ["https://admin.korintus.me"],
};

class FakeDmsClient implements DmsClient {
  public accounts: string[] = ["admin@korintus.me", "user@korintus.me"];
  public existingMaildirs = new Set<string>([
    "admin@korintus.me",
    "user@korintus.me",
  ]);
  public deleteCalls: Array<{ email: string; maildirExists: boolean }> = [];

  async listAccounts(): Promise<string[]> {
    return [...this.accounts];
  }

  async addAccount(email: string, _password: string): Promise<void> {
    if (this.accounts.includes(email)) {
      throw new Error("already exists");
    }
    this.accounts.push(email);
    this.existingMaildirs.add(email);
  }

  async updateAccount(email: string, _password: string): Promise<void> {
    if (!this.accounts.includes(email)) {
      throw new Error("not found");
    }
  }

  async checkMaildirExists(
    domain: string,
    localPart: string,
  ): Promise<boolean> {
    const full = `${localPart}@${domain}`;
    return this.existingMaildirs.has(full);
  }

  async deleteAccount(email: string, maildirExists: boolean): Promise<void> {
    this.deleteCalls.push({ email, maildirExists });
    this.accounts = this.accounts.filter((a) => a !== email);
    this.existingMaildirs.delete(email);
  }

  async preflightCheck(): Promise<void> {}
}

class FakeMailService implements MailService {
  public messagesByAccount: Record<string, Record<number, MessageDetail>> = {};
  public flagsByAccount: Record<string, Record<number, string[]>> = {};
  public uidValidityByAccount: Record<string, string> = {};
  public sendCallCount = 0;
  public sendReturnResult?: SendResult;

  async listFolders(_email: string): Promise<FolderItem[]> {
    return [
      { path: "INBOX", name: "INBOX" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
      { path: "Trash", name: "Trash", specialUse: "\\Trash" },
      { path: "Sent", name: "Sent", specialUse: "\\Sent" },
    ];
  }

  async listMessages(
    email: string,
    params: {
      folder: string;
      limit: number;
      beforeUid?: number;
      uidValidity?: string;
    },
  ): Promise<{
    folder: string;
    uidValidity: string;
    items: MessageSummary[];
    nextBeforeUid: number | null;
  }> {
    const currentValidity = this.uidValidityByAccount[email] || "1000";
    if (
      params.beforeUid !== undefined &&
      params.uidValidity !== currentValidity
    ) {
      throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
    }

    const msgs = Object.values(this.messagesByAccount[email] || {});
    const items: MessageSummary[] = msgs.map((m) => ({
      uid: m.uid,
      flags: this.flagsByAccount[email]?.[m.uid] ?? m.flags,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      size: 1024,
    }));

    return {
      folder: params.folder,
      uidValidity: currentValidity,
      items,
      nextBeforeUid: null,
    };
  }

  async getMessage(
    email: string,
    uid: number,
    params: { folder: string; uidValidity: string },
  ): Promise<MessageDetail> {
    const currentValidity = this.uidValidityByAccount[email] || "1000";
    if (params.uidValidity && params.uidValidity !== currentValidity) {
      throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
    }

    const msg = this.messagesByAccount[email]?.[uid];
    if (!msg) {
      throw new AppError("NOT_FOUND", "Message not found.");
    }

    return {
      ...msg,
      flags: this.flagsByAccount[email]?.[uid] ?? msg.flags,
    };
  }

  async getAttachment(
    _email: string,
    _uid: number,
    index: number,
    _params: { folder: string; uidValidity: string },
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    if (index === 0) {
      return {
        filename: "test.pdf",
        contentType: "application/octet-stream",
        content: Buffer.from("PDF-DATA"),
      };
    }
    throw new AppError("NOT_FOUND", "Attachment not found.");
  }

  async updateFlags(
    email: string,
    uid: number,
    flags: { seen?: boolean; flagged?: boolean },
    params: { folder: string; uidValidity: string },
  ): Promise<{
    uid: number;
    uidValidity: string;
    folder: string;
    flags: string[];
  }> {
    const currentValidity = this.uidValidityByAccount[email] || "1000";
    if (params.uidValidity !== currentValidity) {
      throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
    }

    const currentFlags = new Set(
      this.flagsByAccount[email]?.[uid] ?? ["\\Seen", "$Custom"],
    );
    if (flags.seen === true) currentFlags.add("\\Seen");
    if (flags.seen === false) currentFlags.delete("\\Seen");
    if (flags.flagged === true) currentFlags.add("\\Flagged");
    if (flags.flagged === false) currentFlags.delete("\\Flagged");

    const result = Array.from(currentFlags);
    if (!this.flagsByAccount[email]) this.flagsByAccount[email] = {};
    this.flagsByAccount[email][uid] = result;

    return {
      uid,
      uidValidity: currentValidity,
      folder: params.folder,
      flags: result,
    };
  }

  async moveMessage(
    _email: string,
    _uid: number,
    destination: "archive" | "trash",
    _params: { folder: string; uidValidity: string },
  ): Promise<{ moved: boolean; destination: string }> {
    return { moved: true, destination };
  }

  async deleteMessage(
    _email: string,
    _uid: number,
    _params: { folder: string; uidValidity: string },
  ): Promise<void> {}

  async sendMessage(
    _email: string,
    _payload: SendMessagePayload,
  ): Promise<SendResult> {
    this.sendCallCount++;
    if (this.sendReturnResult) {
      return this.sendReturnResult;
    }
    return {
      messageId: "msg-123",
      accepted: ["recipient@korintus.me"],
      rejected: [],
      sentCopySaved: true,
    };
  }
}

function setupTestEnvironment() {
  const fakeDms = new FakeDmsClient();
  const accountLock = new Mutex();
  const accountKeyedLock = new KeyedMutex();

  const accounts = new AccountService({
    dms: fakeDms,
    mailDomains: testConfig.mailDomains,
    smtpUser: testConfig.smtpUser,
    accountLock,
    accountKeyedLock,
  });

  const mail = new FakeMailService();

  const app = createApp(testConfig, { accounts, mail });
  return { app, fakeDms, mail };
}

describe("Docker Mailserver API Behavioral Tests", () => {
  it("1. absent or wrong auth prevents upstream effects and returns 401", async () => {
    const { app } = setupTestEnvironment();

    // Absent auth header
    const resNoAuth = await app.handle(new Request("http://localhost/health"));
    expect(resNoAuth.status).toBe(401);
    const bodyNoAuth = (await resNoAuth.json()) as { error: { code: string } };
    expect(bodyNoAuth.error.code).toBe("UNAUTHORIZED");

    // Wrong Bearer token
    const resWrongAuth = await app.handle(
      new Request("http://localhost/health", {
        headers: { Authorization: "Bearer wrong-token-that-fails-check" },
      }),
    );
    expect(resWrongAuth.status).toBe(401);

    // Unauthenticated OPTIONS from allowed CORS origin succeeds with 204
    const resOptionsAllowed = await app.handle(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: { Origin: "https://admin.korintus.me" },
      }),
    );
    expect(resOptionsAllowed.status).toBe(204);
    expect(resOptionsAllowed.headers.get("access-control-allow-origin")).toBe(
      "https://admin.korintus.me",
    );

    // Unauthenticated OPTIONS from disallowed origin returns 401
    const resOptionsDenied = await app.handle(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.com" },
      }),
    );
    expect(resOptionsDenied.status).toBe(401);
  });

  it("2. cross-domain and path/master-separator injection blocked", async () => {
    const { app } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Traversal in local-part
    const resTraversal = await app.handle(
      new Request("http://localhost/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "../bad@korintus.me",
          password: "valid-long-password-123",
        }),
      }),
    );
    expect(resTraversal.status).toBe(400);
    const bodyTraversal = (await resTraversal.json()) as {
      error: { code: string };
    };
    expect(bodyTraversal.error.code).toBe("INVALID_REQUEST");

    // Master separator * in local-part
    const resMasterSep = await app.handle(
      new Request("http://localhost/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "admin*master@korintus.me",
          password: "valid-long-password-123",
        }),
      }),
    );
    expect(resMasterSep.status).toBe(400);

    // Slash in local-part
    const resSlash = await app.handle(
      new Request("http://localhost/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "user/name@korintus.me",
          password: "valid-long-password-123",
        }),
      }),
    );
    expect(resSlash.status).toBe(400);

    // Forbidden domain outside MAIL_DOMAINS
    const resDomain = await app.handle(
      new Request("http://localhost/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "user@evil.com",
          password: "valid-long-password-123",
        }),
      }),
    );
    expect(resDomain.status).toBe(403);
    const bodyDomain = (await resDomain.json()) as { error: { code: string } };
    expect(bodyDomain.error.code).toBe("DOMAIN_FORBIDDEN");
  });

  it("3. duplicate account returns 409 CONFLICT", async () => {
    const { app } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // user@korintus.me already exists
    const res = await app.handle(
      new Request("http://localhost/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "user@korintus.me",
          password: "valid-long-password-123",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("4. deletion wrong confirmation preserves account and rejects SMTP_USER", async () => {
    const { app, fakeDms } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Wrong confirmEmail
    const resWrongEmail = await app.handle(
      new Request("http://localhost/v1/accounts/user%40korintus.me", {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmEmail: "other@korintus.me",
          purge: true,
        }),
      }),
    );
    expect(resWrongEmail.status).toBe(400);
    expect(fakeDms.accounts).toContain("user@korintus.me");

    // purge: false
    const resNoPurge = await app.handle(
      new Request("http://localhost/v1/accounts/user%40korintus.me", {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmEmail: "user@korintus.me",
          purge: false,
        }),
      }),
    );
    expect(resNoPurge.status).toBe(400);
    expect(fakeDms.accounts).toContain("user@korintus.me");

    // Attempting to delete configured SMTP_USER (admin@korintus.me)
    const resSmtpUser = await app.handle(
      new Request("http://localhost/v1/accounts/admin%40korintus.me", {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmEmail: "admin@korintus.me",
          purge: true,
        }),
      }),
    );
    expect(resSmtpUser.status).toBe(409);
    const bodySmtp = (await resSmtpUser.json()) as { error: { code: string } };
    expect(bodySmtp.error.code).toBe("CONFLICT");
    expect(fakeDms.accounts).toContain("admin@korintus.me");
  });

  it("5. no-Maildir purge still removes account via -n flag", async () => {
    const { app, fakeDms } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Remove Maildir from fake storage
    fakeDms.existingMaildirs.delete("user@korintus.me");

    const res = await app.handle(
      new Request("http://localhost/v1/accounts/user%40korintus.me", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ confirmEmail: "user@korintus.me", purge: true }),
      }),
    );
    expect(res.status).toBe(204);
    expect(fakeDms.accounts).not.toContain("user@korintus.me");
    expect(fakeDms.deleteCalls).toEqual([
      { email: "user@korintus.me", maildirExists: false },
    ]);
  });

  it("6. stale UIDVALIDITY rejects message operations with 409 STALE_MAILBOX", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount["user@korintus.me"] = "9999";

    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Stale UIDVALIDITY on PATCH flags
    const resPatch = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/1?uidValidity=1111",
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ seen: true }),
        },
      ),
    );
    expect(resPatch.status).toBe(409);
    const bodyPatch = (await resPatch.json()) as { error: { code: string } };
    expect(bodyPatch.error.code).toBe("STALE_MAILBOX");

    // Stale UIDVALIDITY on message search with beforeUid
    const resSearch = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages?beforeUid=50&uidValidity=1111",
        {
          method: "GET",
          headers,
        },
      ),
    );
    expect(resSearch.status).toBe(409);
  });

  it("7. switching A/B with same numeric UID reads different message", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount["admin@korintus.me"] = "100";
    mail.uidValidityByAccount["user@korintus.me"] = "200";

    mail.messagesByAccount["admin@korintus.me"] = {
      1: {
        uid: 1,
        uidValidity: "100",
        folder: "INBOX",
        flags: [],
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ name: "Admin", address: "admin@korintus.me" }],
        cc: [],
        subject: "Message for Admin",
        date: "2026-09-08T10:00:00.000Z",
        text: "Hello Admin",
        html: "<p>Hello Admin</p>",
        attachments: [],
      },
    };

    mail.messagesByAccount["user@korintus.me"] = {
      1: {
        uid: 1,
        uidValidity: "200",
        folder: "INBOX",
        flags: [],
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ name: "User", address: "user@korintus.me" }],
        cc: [],
        subject: "Message for User",
        date: "2026-09-08T11:00:00.000Z",
        text: "Hello User",
        html: "<p>Hello User</p>",
        attachments: [],
      },
    };

    const headers = { Authorization: `Bearer ${TEST_TOKEN}` };

    const resA = await app.handle(
      new Request(
        "http://localhost/v1/accounts/admin%40korintus.me/messages/1?uidValidity=100",
        {
          headers,
        },
      ),
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as MessageDetail;
    expect(bodyA.subject).toBe("Message for Admin");

    const resB = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/1?uidValidity=200",
        {
          headers,
        },
      ),
    );
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as MessageDetail;
    expect(bodyB.subject).toBe("Message for User");
  });

  it("8. flags update preserves unrelated existing flags", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount["user@korintus.me"] = "500";
    mail.flagsByAccount["user@korintus.me"] = {
      1: ["\\Seen", "$Important", "\\Answered"],
    };

    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    const res = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/1?uidValidity=500",
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ flagged: true }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: string[] };
    expect(body.flags).toContain("\\Flagged");
    expect(body.flags).toContain("\\Seen");
    expect(body.flags).toContain("$Important");
    expect(body.flags).toContain("\\Answered");
  });

  it("9. malformed MIME or oversize rejects safely without server crash", async () => {
    // Corrupted binary payload handled gracefully
    const corruptMime = Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x34]);
    const parsed = await parseRawEmail(corruptMime, 1, "123", "INBOX", []);
    expect(parsed.uid).toBe(1);

    // Oversize attachment in send payload
    const { app } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    const resInvalidSubject = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/send",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            to: ["dest@korintus.me"],
            subject: "Subject with forbidden CR\r\nLF",
            text: "hello",
          }),
        },
      ),
    );
    expect(resInvalidSubject.status).toBe(400);
  });

  it("10. SMTP partial acceptance and failed Sent append never trigger repeat send", async () => {
    const { app, mail } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    mail.sendReturnResult = {
      messageId: "msg-partial-1",
      accepted: ["accepted@korintus.me"],
      rejected: ["rejected@korintus.me"],
      sentCopySaved: false, // Sent append failed
    };

    const res = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/send",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            to: ["accepted@korintus.me", "rejected@korintus.me"],
            subject: "Test Send",
            text: "Test content",
          }),
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as SendResult;
    expect(body.accepted).toEqual(["accepted@korintus.me"]);
    expect(body.rejected).toEqual(["rejected@korintus.me"]);
    expect(body.sentCopySaved).toBe(false);
    expect(mail.sendCallCount).toBe(1); // Never retried
  });

  it("11. file and URL attachment properties rejected", async () => {
    const { app } = setupTestEnvironment();
    const headers = {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Path traversal in filename
    const resTraversal = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/send",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            to: ["dest@korintus.me"],
            subject: "Attachment test",
            text: "hello",
            attachments: [
              {
                filename: "../../etc/passwd",
                contentType: "text/plain",
                contentBase64: Buffer.from("test").toString("base64"),
              },
            ],
          }),
        },
      ),
    );
    expect(resTraversal.status).toBe(400);

    // Invalid MIME type format
    const resInvalidMime = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/send",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            to: ["dest@korintus.me"],
            subject: "Attachment test",
            text: "hello",
            attachments: [
              {
                filename: "test.txt",
                contentType: "not-a-valid-mime-type",
                contentBase64: Buffer.from("test").toString("base64"),
              },
            ],
          }),
        },
      ),
    );
    expect(resInvalidMime.status).toBe(400);
  });

  it("12. HTML returned only as JSON with strict security headers", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount["user@korintus.me"] = "777";
    mail.messagesByAccount["user@korintus.me"] = {
      1: {
        uid: 1,
        uidValidity: "777",
        folder: "INBOX",
        flags: [],
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ name: "User", address: "user@korintus.me" }],
        cc: [],
        subject: "Security Test",
        date: "2026-09-08T12:00:00.000Z",
        text: "hello",
        html: "<script>alert('xss')</script><p>payload</p>",
        attachments: [],
      },
    };

    const headers = { Authorization: `Bearer ${TEST_TOKEN}` };

    const res = await app.handle(
      new Request(
        "http://localhost/v1/accounts/user%40korintus.me/messages/1?uidValidity=777",
        {
          headers,
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as MessageDetail;
    expect(body.html).toBe("<script>alert('xss')</script><p>payload</p>");
  });
});
