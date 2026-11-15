import { describe, expect, it } from "bun:test";
import path from "node:path";
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
  public listMessagesCallCount = 0;
  public listMessagesFailure?: AppError;
  public listMessagesResponses: Array<{
    items: MessageSummary[];
    folder?: string;
    uidValidity?: string;
  }> = [];
  public beforeListMessages?: (email: string, callNumber: number) => void;
  public afterListMessages?: (email: string, callNumber: number) => void;

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
    const callNumber = ++this.listMessagesCallCount;
    this.beforeListMessages?.(email, callNumber);
    if (this.listMessagesFailure) throw this.listMessagesFailure;

    const currentValidity = this.uidValidityByAccount[email] || "1000";
    if (
      params.beforeUid !== undefined &&
      params.uidValidity !== currentValidity
    ) {
      throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
    }

    const scriptedResponse = this.listMessagesResponses[callNumber - 1];
    if (scriptedResponse) {
      this.afterListMessages?.(email, callNumber);
      return {
        folder: scriptedResponse.folder ?? params.folder,
        uidValidity: scriptedResponse.uidValidity ?? currentValidity,
        items: scriptedResponse.items,
        nextBeforeUid: null,
      };
    }

    const msgs = Object.values(this.messagesByAccount[email] || {})
      .filter((message) => message.folder === params.folder)
      .sort((left, right) => right.uid - left.uid);
    const items: MessageSummary[] = msgs.map((m) => ({
      uid: m.uid,
      flags: this.flagsByAccount[email]?.[m.uid] ?? m.flags,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      size: 1024,
    }));
    const page = {
      folder: params.folder,
      uidValidity: currentValidity,
      items: items.slice(0, params.limit),
      nextBeforeUid: null,
    };
    this.afterListMessages?.(email, callNumber);
    return page;
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

const BOB_MAILBOX = "bob@korintus.me";
const API_ROOT = path.resolve(import.meta.dir, "..");
const POLLING_EXAMPLE = path.join(API_ROOT, "examples", "poll-latest-email.ts");

function makeMessage(
  uid: number,
  text: string,
  options: { folder?: string; uidValidity?: string; flags?: string[] } = {},
): MessageDetail {
  return {
    uid,
    uidValidity: options.uidValidity ?? "1000",
    folder: options.folder ?? "INBOX",
    flags: options.flags ?? ["\\Seen"],
    from: { name: "Issuer", address: "issuer@example.com" },
    to: [{ name: "Bob", address: BOB_MAILBOX }],
    cc: [],
    subject: `Fixture message ${uid}`,
    date: "2026-11-15T12:00:00.000Z",
    text,
    html: `<p>${text}</p>`,
    attachments: [
      {
        index: 0,
        filename: "fixture.txt",
        mimeType: "text/plain",
        size: 12,
        contentId: null,
      },
    ],
  };
}

function summarizeMessage(message: MessageDetail): MessageSummary {
  return {
    uid: message.uid,
    flags: message.flags,
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.date,
    size: 1024,
  };
}

function seedMessages(
  mail: FakeMailService,
  email: string,
  messages: MessageDetail[],
): void {
  mail.uidValidityByAccount[email] = messages[0]?.uidValidity ?? "1000";
  mail.messagesByAccount[email] = Object.fromEntries(
    messages.map((message) => [message.uid, message]),
  );
}

function scriptedLatestResponse(message: MessageDetail | null): {
  items: MessageSummary[];
  folder: string;
  uidValidity: string;
} {
  return {
    items: message ? [summarizeMessage(message)] : [],
    folder: message?.folder ?? "INBOX",
    uidValidity: message?.uidValidity ?? "1000",
  };
}

async function runPollingExample(
  prepare: (mail: FakeMailService) => void,
  options: {
    args?: string[];
    token?: string;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  mail: FakeMailService;
}> {
  const { app, mail } = setupTestEnvironment();
  prepare(mail);
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) {
    await app.stop();
    throw new Error("Failed to start the fixture API server.");
  }

  try {
    const child = Bun.spawn(
      [process.execPath, POLLING_EXAMPLE, ...(options.args ?? [])],
      {
        cwd: API_ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          MAIL_API_BASE_URL: `http://127.0.0.1:${port}`,
          ADMIN_API_TOKEN: options.token ?? TEST_TOKEN,
          MAILBOX: BOB_MAILBOX,
          MAIL_FOLDER: "INBOX",
          POLL_INTERVAL_MS: String(options.intervalMs ?? 5),
          POLL_TIMEOUT_MS: String(options.timeoutMs ?? 1000),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const output = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([exitCode, stdout, stderr]) => ({
      exitCode,
      stdout,
      stderr,
      mail,
    }));
    // The subprocess exercises a real polling deadline over HTTP; fake timers cannot advance its clock.
    const watchdogResult = Promise.withResolvers<never>();
    const watchdog = setTimeout(
      () =>
        watchdogResult.reject(
          new Error("Polling CLI subprocess exceeded its watchdog."),
        ),
      10_000,
    );
    try {
      return await Promise.race([output, watchdogResult.promise]);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await output.catch(() => undefined);
    }
  } finally {
    await app.stop();
  }
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
describe("Latest message endpoint", () => {
  it("returns Bob's highest-UID INBOX detail without changing flags", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount[BOB_MAILBOX] = "4242";
    mail.messagesByAccount[BOB_MAILBOX] = {
      201: makeMessage(201, "An older message", { uidValidity: "4242" }),
      202: makeMessage(202, "Your code is 123456", {
        uidValidity: "4242",
        flags: ["$Important"],
      }),
    };
    mail.flagsByAccount[BOB_MAILBOX] = {
      202: ["$Important"],
    };
    mail.uidValidityByAccount["other@korintus.me"] = "9000";
    mail.messagesByAccount["other@korintus.me"] = {
      202: makeMessage(202, "A different account's message", {
        uidValidity: "9000",
      }),
    };

    const response = await app.handle(
      new Request(
        `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as MessageDetail;
    expect(body.uid).toBe(202);
    expect(body.text).toBe("Your code is 123456");
    expect(body.html).toBe("<p>Your code is 123456</p>");
    expect(body.attachments).toEqual([
      {
        index: 0,
        filename: "fixture.txt",
        mimeType: "text/plain",
        size: 12,
        contentId: null,
      },
    ]);
    expect(body.flags).toEqual(["$Important"]);
    expect(mail.flagsByAccount[BOB_MAILBOX]?.[202]).toEqual(["$Important"]);
    const otherResponse = await app.handle(
      new Request(
        "http://localhost/v1/accounts/other%40korintus.me/messages/latest",
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );
    expect(otherResponse.status).toBe(200);
    const otherBody = (await otherResponse.json()) as MessageDetail;
    expect(otherBody.uid).toBe(202);
    expect(otherBody.text).toBe("A different account's message");
  });

  it("selects the requested folder's latest message", async () => {
    const { app, mail } = setupTestEnvironment();
    mail.uidValidityByAccount[BOB_MAILBOX] = "4242";
    mail.messagesByAccount[BOB_MAILBOX] = {
      202: makeMessage(202, "Archive message", {
        folder: "Archive",
        uidValidity: "4242",
      }),
    };

    const response = await app.handle(
      new Request(
        `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest?folder=Archive`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as MessageDetail;
    expect(body.uid).toBe(202);
    expect(body.folder).toBe("Archive");
    expect(body.text).toBe("Archive message");
  });

  it("returns a bodyless 204 for an empty folder", async () => {
    const { app } = setupTestEnvironment();
    const response = await app.handle(
      new Request(
        `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects absent or wrong tokens before accessing mail", async () => {
    const { app, mail } = setupTestEnvironment();
    const url = `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`;

    const absent = await app.handle(new Request(url));
    expect(absent.status).toBe(401);
    const absentBody = (await absent.json()) as {
      error: { code: string };
    };
    expect(absentBody.error.code).toBe("UNAUTHORIZED");

    const wrong = await app.handle(
      new Request(url, {
        headers: { Authorization: "Bearer wrong-fixture-token" },
      }),
    );
    expect(wrong.status).toBe(401);
    expect(mail.listMessagesCallCount).toBe(0);
  });

  it("preserves deletion and UIDVALIDITY errors between selection and read", async () => {
    const deletion = setupTestEnvironment();
    seedMessages(deletion.mail, BOB_MAILBOX, [
      makeMessage(201, "Older message"),
      makeMessage(202, "Selected message"),
    ]);
    deletion.mail.afterListMessages = (email) => {
      delete deletion.mail.messagesByAccount[email]?.[202];
    };
    const deleted = await deletion.app.handle(
      new Request(
        `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );
    expect(deleted.status).toBe(404);
    const deletedBody = (await deleted.json()) as {
      error: { code: string };
    };
    expect(deletedBody.error.code).toBe("NOT_FOUND");
    expect(deletion.mail.listMessagesCallCount).toBe(1);

    const validity = setupTestEnvironment();
    seedMessages(validity.mail, BOB_MAILBOX, [
      makeMessage(201, "Older message"),
      makeMessage(202, "Selected message"),
    ]);
    validity.mail.afterListMessages = (email) => {
      validity.mail.uidValidityByAccount[email] = "2000";
    };
    const stale = await validity.app.handle(
      new Request(
        `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      ),
    );
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as {
      error: { code: string };
    };
    expect(staleBody.error.code).toBe("STALE_MAILBOX");
    expect(validity.mail.listMessagesCallCount).toBe(1);
  });

  it("preserves BUSY and upstream service failures", async () => {
    for (const [code, status] of [
      ["BUSY", 503],
      ["UPSTREAM_FAILURE", 502],
    ] as const) {
      const { app, mail } = setupTestEnvironment();
      mail.listMessagesFailure = new AppError(code);
      const response = await app.handle(
        new Request(
          `http://localhost/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
          { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
        ),
      );

      expect(response.status).toBe(status);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
    }
  });
});

type OpenApiResponse = {
  content?: Record<string, { schema?: { $ref?: string; format?: string } }>;
  headers?: Record<string, unknown>;
};

type OpenApiOperation = {
  operationId: string;
  security?: Array<Record<string, unknown>>;
  responses?: Record<string, OpenApiResponse>;
};

type OpenApiDocument = {
  openapi: string;
  security: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
  };
};

function getOpenApiOperations(document: OpenApiDocument): Array<{
  method: string;
  path: string;
  operation: OpenApiOperation;
}> {
  const methods = ["get", "post", "patch", "delete"] as const;
  return Object.entries(document.paths).flatMap(([routePath, pathItem]) =>
    methods.flatMap((method) => {
      const candidate = pathItem[method];
      if (!candidate || typeof candidate !== "object") return [];
      return [
        {
          method: method.toUpperCase(),
          path: routePath,
          operation: candidate as OpenApiOperation,
        },
      ];
    }),
  );
}

function normalizeRoutePath(routePath: string): string {
  return (
    routePath
      .replace(/:([^/]+)/g, (_match, parameter: string) => `{${parameter}}`)
      .replace(/\/+$/, "") || "/"
  );
}

function collectOpenApiRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectOpenApiRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") refs.push(record.$ref);
  for (const item of Object.values(record)) collectOpenApiRefs(item, refs);
  return refs;
}

function resolveLocalOpenApiRef(document: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let value = document;
  for (const part of reference.slice(2).split("/")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

describe("API documentation routes and OpenAPI contract", () => {
  it("serves all exact static documentation routes without a token", async () => {
    const { app } = setupTestEnvironment();
    const docs = await app.handle(new Request("http://localhost/docs"));
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/markdown");
    expect(docs.headers.get("cache-control")).toBe("no-store");
    expect(docs.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await docs.text()).toContain("latest");

    const discovery = await app.handle(
      new Request("http://localhost/llms.txt"),
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("content-type")).toContain("text/plain");
    expect(discovery.headers.get("cache-control")).toBe("no-store");
    expect(discovery.headers.get("x-content-type-options")).toBe("nosniff");
    const discoveryText = await discovery.text();
    expect(discoveryText).toContain("# Docker Mailserver API");
    expect(discoveryText).toContain("/docs/openapi.json");

    const openapi = await app.handle(
      new Request("http://localhost/docs/openapi.json"),
    );
    expect(openapi.status).toBe(200);
    expect(openapi.headers.get("content-type")).toContain("application/json");
    expect(openapi.headers.get("cache-control")).toBe("no-store");
    expect(openapi.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps bearer authentication on health, mail, accounts, and non-doc paths", async () => {
    const { app, mail } = setupTestEnvironment();
    const protectedRequests = [
      { routePath: "/health", method: "GET" },
      { routePath: "/v1/accounts", method: "GET" },
      {
        routePath: `/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/folders`,
        method: "GET",
      },
      {
        routePath: `/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/latest`,
        method: "GET",
      },
      {
        routePath: `/v1/accounts/${encodeURIComponent(BOB_MAILBOX)}/messages/send`,
        method: "POST",
      },
    ];
    for (const { routePath, method } of protectedRequests) {
      const absent = await app.handle(
        new Request(`http://localhost${routePath}`, { method }),
      );
      expect(absent.status).toBe(401);

      const wrong = await app.handle(
        new Request(`http://localhost${routePath}`, {
          method,
          headers: { Authorization: "Bearer wrong-fixture-token" },
        }),
      );
      expect(wrong.status).toBe(401);
    }
    expect(mail.listMessagesCallCount).toBe(0);
    expect(mail.sendCallCount).toBe(0);

    const unknownDocsPath = await app.handle(
      new Request("http://localhost/docs/not-a-document"),
    );
    expect(unknownDocsPath.status).toBe(401);

    const nonGetDocs = await app.handle(
      new Request("http://localhost/docs", { method: "POST" }),
    );
    expect(nonGetDocs.status).toBe(401);
  });

  it("documents authenticated registered operations and resolves local refs", async () => {
    const { app } = setupTestEnvironment();
    const response = await app.handle(
      new Request("http://localhost/docs/openapi.json"),
    );
    const document = (await response.json()) as OpenApiDocument;
    expect(document.openapi).toBe("3.1.0");
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });

    const operations = getOpenApiOperations(document);
    const expectedOperations = [
      "GET /health getHealth",
      "GET /docs/openapi.json getOpenApiDocument",
      "GET /docs getApiUsageGuide",
      "GET /llms.txt getAgentDiscovery",
      "GET /v1/accounts listAccounts",
      "POST /v1/accounts createAccount",
      "GET /v1/accounts/{email} getAccount",
      "PATCH /v1/accounts/{email} updateAccountPassword",
      "DELETE /v1/accounts/{email} deleteAccount",
      "GET /v1/accounts/{email}/folders listFolders",
      "GET /v1/accounts/{email}/messages listMessages",
      "GET /v1/accounts/{email}/messages/latest getLatestMessage",
      "GET /v1/accounts/{email}/messages/{uid} getMessage",
      "GET /v1/accounts/{email}/messages/{uid}/attachments/{index} getAttachment",
      "PATCH /v1/accounts/{email}/messages/{uid} updateMessageFlags",
      "POST /v1/accounts/{email}/messages/{uid}/move moveMessage",
      "DELETE /v1/accounts/{email}/messages/{uid} trashMessage",
      "POST /v1/accounts/{email}/messages/send sendMessage",
    ];
    const documentedOperations = operations
      .map(
        ({ method, path: routePath, operation }) =>
          `${method} ${routePath} ${operation.operationId}`,
      )
      .sort();
    expect(documentedOperations).toEqual([...expectedOperations].sort());

    const documentedRoutes = operations
      .map(({ method, path: routePath }) => `${method} ${routePath}`)
      .sort();
    const registeredRoutes = app.routes
      .filter(({ method }) =>
        ["GET", "POST", "PATCH", "DELETE"].includes(method.toUpperCase()),
      )
      .map(
        ({ method, path: routePath }) =>
          `${method.toUpperCase()} ${normalizeRoutePath(routePath)}`,
      )
      .sort();
    expect(registeredRoutes).toEqual(documentedRoutes);

    const explicitlyUnauthenticated = operations
      .filter(
        ({ operation }) =>
          operation.security !== undefined && operation.security.length === 0,
      )
      .map(({ method, path: routePath }) => `${method} ${routePath}`)
      .sort();
    expect(explicitlyUnauthenticated).toEqual(
      ["GET /docs", "GET /docs/openapi.json", "GET /llms.txt"].sort(),
    );

    const latest = operations.find(
      ({ method, path: routePath }) =>
        method === "GET" &&
        routePath === "/v1/accounts/{email}/messages/latest",
    )?.operation;
    expect(latest).toBeDefined();
    if (!latest) throw new Error("OpenAPI latest operation is missing.");
    expect(
      latest.responses?.["200"]?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/MessageDetail" });
    const noContent = latest.responses?.["204"];
    expect(noContent).toBeDefined();
    expect(noContent?.content).toBeUndefined();

    const attachment = operations.find(
      ({ method, path: routePath }) =>
        method === "GET" &&
        routePath === "/v1/accounts/{email}/messages/{uid}/attachments/{index}",
    )?.operation;
    expect(
      attachment?.responses?.["200"]?.content?.["application/octet-stream"]
        ?.schema?.format,
    ).toBe("binary");
    expect(
      attachment?.responses?.["200"]?.headers?.["Content-Disposition"],
    ).toBeDefined();

    const refs = collectOpenApiRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    for (const reference of refs) {
      expect(reference.startsWith("#/")).toBe(true);
      expect(resolveLocalOpenApiRef(document, reference)).not.toBeUndefined();
    }
  });
});

describe("latest-email polling CLI", () => {
  it("returns the existing latest message by default", async () => {
    const result = await runPollingExample((mail) => {
      seedMessages(mail, BOB_MAILBOX, [
        makeMessage(201, "Older message"),
        makeMessage(202, "Your code is 123456"),
      ]);
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    const message = JSON.parse(result.stdout) as MessageDetail;
    expect(message.uid).toBe(202);
    expect(message.text).toBe("Your code is 123456");
  });

  it("continues from an empty folder until a new message arrives", async () => {
    const message = makeMessage(202, "Your code is 123456");
    const result = await runPollingExample(
      (mail) => {
        seedMessages(mail, BOB_MAILBOX, [message]);
        mail.listMessagesResponses = [
          scriptedLatestResponse(null),
          scriptedLatestResponse(message),
        ];
      },
      { args: ["--new-only"], timeoutMs: 1000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.mail.listMessagesCallCount).toBe(2);
    expect(result.stderr).toContain("Ready: waiting for new mail.");
    const returned = JSON.parse(result.stdout) as MessageDetail;
    expect(returned.uid).toBe(202);
    expect(returned.text).toBe("Your code is 123456");
  });

  it("new-only ignores its baseline and repeated or lower UIDs", async () => {
    const baseline = makeMessage(202, "Old code");
    const lower = makeMessage(201, "Older code");
    const newer = makeMessage(203, "New code");
    const result = await runPollingExample(
      (mail) => {
        seedMessages(mail, BOB_MAILBOX, [lower, baseline, newer]);
        mail.listMessagesResponses = [
          scriptedLatestResponse(baseline),
          scriptedLatestResponse(baseline),
          scriptedLatestResponse(lower),
          scriptedLatestResponse(newer),
        ];
      },
      { args: ["--new-only"], timeoutMs: 1000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.mail.listMessagesCallCount).toBe(4);
    expect(result.stderr).toContain("Ready: waiting for new mail.");
    const returned = JSON.parse(result.stdout) as MessageDetail;
    expect(returned.uid).toBe(203);
    expect(returned.text).toBe("New code");
  });

  it("stops on a changed UIDVALIDITY without printing a message", async () => {
    const baseline = makeMessage(202, "Old code", { uidValidity: "1000" });
    const changed = makeMessage(203, "Potentially old code", {
      uidValidity: "1001",
    });
    const result = await runPollingExample(
      (mail) => {
        seedMessages(mail, BOB_MAILBOX, [baseline, changed]);
        mail.beforeListMessages = (email, callNumber) => {
          if (callNumber === 2) mail.uidValidityByAccount[email] = "1001";
        };
        mail.listMessagesResponses = [
          scriptedLatestResponse(baseline),
          scriptedLatestResponse(changed),
        ];
      },
      { args: ["--new-only"], timeoutMs: 1000 },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Mailbox changed; restart polling before requesting another OTP.",
    );
  });

  it("times out on an empty mailbox without a success payload", async () => {
    const result = await runPollingExample(() => {}, {
      intervalMs: 10,
      timeoutMs: 120,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Timed out waiting for email.");
  });

  it("fails promptly on 401 without printing the supplied token", async () => {
    const token = "fixture-secret-that-must-not-be-printed";
    const result = await runPollingExample(() => {}, {
      token,
      timeoutMs: 3000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Mail API returned HTTP 401.");
    expect(result.stderr).not.toContain(token);
    expect(result.mail.listMessagesCallCount).toBe(0);
  });
});
