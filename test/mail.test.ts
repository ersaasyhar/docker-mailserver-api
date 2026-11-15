import { describe, expect, it } from "bun:test";
import {
  normalizeAndValidateAccountEmail,
  validateAccountPassword,
} from "../src/accounts";
import { loadConfig, validateCorsOrigin } from "../src/config";
import { selectLatestReceivedMessage } from "../src/mail";
import {
  extractAttachment,
  parseRawEmail,
  validateFolder,
  validateUid,
  validateUidValidity,
} from "../src/messages";

describe("Configuration and Protocol Edge Cases", () => {
  it("validates CORS origin rules strictly", () => {
    // Valid origins
    expect(validateCorsOrigin("https://admin.example.com")).toBe(
      "https://admin.example.com",
    );
    expect(validateCorsOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );

    // Rejected origins
    expect(() => validateCorsOrigin("*")).toThrow();
    expect(() => validateCorsOrigin("null")).toThrow();
    expect(() => validateCorsOrigin("https://*.example.com")).toThrow();
    expect(() =>
      validateCorsOrigin("https://admin.example.com/path"),
    ).toThrow();
    expect(() =>
      validateCorsOrigin("https://user:pass@admin.example.com"),
    ).toThrow();
    expect(() =>
      validateCorsOrigin("https://admin.example.com?query=1"),
    ).toThrow();
    expect(() => validateCorsOrigin("ftp://admin.example.com")).toThrow();
  });

  it("validates TAILSCALE_IP within 100.64.0.0/10", () => {
    const validEnv = {
      TAILSCALE_IP: "100.64.10.5",
      ADMIN_API_TOKEN: "12345678901234567890123456789012",
      MAIL_DOMAINS: "korintus.me",
      DMS_CONTAINER: "mailserver",
      IMAP_MASTER_USER: "mail-api",
      IMAP_MASTER_PASSWORD: "pw",
      SMTP_USER: "admin@korintus.me",
      SMTP_PASSWORD: "pw",
      MAIL_TLS_SERVERNAME: "mail.korintus.me",
    };

    // Valid IP inside 100.64.0.0/10 (checkInterfaces: false for unit test)
    const config = loadConfig(validEnv, { checkInterfaces: false });
    expect(config.tailscaleIp).toBe("100.64.10.5");

    // Invalid IP outside 100.64.0.0/10
    expect(() =>
      loadConfig(
        { ...validEnv, TAILSCALE_IP: "192.168.1.1" },
        { checkInterfaces: false },
      ),
    ).toThrow();
    expect(() =>
      loadConfig(
        { ...validEnv, TAILSCALE_IP: "100.128.0.1" },
        { checkInterfaces: false },
      ),
    ).toThrow();
    expect(() =>
      loadConfig(
        { ...validEnv, TAILSCALE_IP: "100.63.255.255" },
        { checkInterfaces: false },
      ),
    ).toThrow();
    expect(() =>
      loadConfig(
        { ...validEnv, TAILSCALE_IP: "not-an-ip" },
        { checkInterfaces: false },
      ),
    ).toThrow();
  });

  it("validates ADMIN_API_TOKEN minimum 32 bytes", () => {
    const validEnv = {
      TAILSCALE_IP: "100.64.10.5",
      ADMIN_API_TOKEN: "too-short",
      MAIL_DOMAINS: "korintus.me",
      DMS_CONTAINER: "mailserver",
      IMAP_MASTER_USER: "mail-api",
      IMAP_MASTER_PASSWORD: "pw",
      SMTP_USER: "admin@korintus.me",
      SMTP_PASSWORD: "pw",
      MAIL_TLS_SERVERNAME: "mail.korintus.me",
    };

    expect(() => loadConfig(validEnv, { checkInterfaces: false })).toThrow();
  });

  it("validates MAIL_DOMAINS lowercase and valid DNS syntax", () => {
    const baseEnv = {
      TAILSCALE_IP: "100.64.10.5",
      ADMIN_API_TOKEN: "12345678901234567890123456789012",
      DMS_CONTAINER: "mailserver",
      IMAP_MASTER_USER: "mail-api",
      IMAP_MASTER_PASSWORD: "pw",
      SMTP_USER: "admin@korintus.me",
      SMTP_PASSWORD: "pw",
      MAIL_TLS_SERVERNAME: "mail.korintus.me",
    };

    // Uppercase domain rejected
    expect(() =>
      loadConfig(
        { ...baseEnv, MAIL_DOMAINS: "Korintus.ME" },
        { checkInterfaces: false },
      ),
    ).toThrow();

    // Invalid domain characters rejected
    expect(() =>
      loadConfig(
        { ...baseEnv, MAIL_DOMAINS: "invalid_domain..com" },
        { checkInterfaces: false },
      ),
    ).toThrow();
  });

  it("validates DMS_CONTAINER syntax", () => {
    const baseEnv = {
      TAILSCALE_IP: "100.64.10.5",
      ADMIN_API_TOKEN: "12345678901234567890123456789012",
      MAIL_DOMAINS: "korintus.me",
      IMAP_MASTER_USER: "mail-api",
      IMAP_MASTER_PASSWORD: "pw",
      SMTP_USER: "admin@korintus.me",
      SMTP_PASSWORD: "pw",
      MAIL_TLS_SERVERNAME: "mail.korintus.me",
    };

    // Leading dash rejected
    expect(() =>
      loadConfig(
        { ...baseEnv, DMS_CONTAINER: "-bad-container" },
        { checkInterfaces: false },
      ),
    ).toThrow();

    // Valid container accepted
    const config = loadConfig(
      { ...baseEnv, DMS_CONTAINER: "mailserver_1" },
      { checkInterfaces: false },
    );
    expect(config.dmsContainer).toBe("mailserver_1");
  });

  it("validates account password lengths and forbidden control chars", () => {
    // Under 12 bytes rejected
    expect(() => validateAccountPassword("short")).toThrow();

    // Over 256 bytes rejected
    expect(() => validateAccountPassword("a".repeat(257))).toThrow();

    // NUL or newlines rejected
    expect(() => validateAccountPassword("valid-password\0extra")).toThrow();
    expect(() => validateAccountPassword("valid-password\r\nextra")).toThrow();

    // Valid 12..256 bytes accepted
    expect(() =>
      validateAccountPassword("a-good-valid-password-1234"),
    ).not.toThrow();
  });

  it("normalizes and validates account email address syntax", () => {
    const allowed = ["korintus.me"];

    // Normalized to lowercase
    const { email } = normalizeAndValidateAccountEmail(
      "USER.Name@Korintus.me",
      allowed,
    );
    expect(email).toBe("user.name@korintus.me");

    // Traversal or dots at ends
    expect(() =>
      normalizeAndValidateAccountEmail(".user@korintus.me", allowed),
    ).toThrow();
    expect(() =>
      normalizeAndValidateAccountEmail("user.@korintus.me", allowed),
    ).toThrow();
    expect(() =>
      normalizeAndValidateAccountEmail("user..name@korintus.me", allowed),
    ).toThrow();

    // Unsupported chars
    expect(() =>
      normalizeAndValidateAccountEmail("user*name@korintus.me", allowed),
    ).toThrow();
    expect(() =>
      normalizeAndValidateAccountEmail("user/name@korintus.me", allowed),
    ).toThrow();
    expect(() =>
      normalizeAndValidateAccountEmail("user\\name@korintus.me", allowed),
    ).toThrow();
  });

  it("parses MIME email and extracts attachments properly", async () => {
    const rawEmail = `From: alice@example.com
To: bob@korintus.me
Subject: Test Attachment
Date: Tue, 08 Sep 2026 12:00:00 +0000
Content-Type: multipart/mixed; boundary="boundary-1"

--boundary-1
Content-Type: text/plain; charset="utf-8"

This is plain text.
--boundary-1
Content-Type: application/octet-stream; name="sample.txt"
Content-Disposition: attachment; filename="sample.txt"
Content-Transfer-Encoding: base64

SGVsbG8gV29ybGQ=
--boundary-1--
`;

    const detail = await parseRawEmail(
      Buffer.from(rawEmail),
      42,
      "999",
      "INBOX",
      ["\\Seen"],
    );
    expect(detail.uid).toBe(42);
    expect(detail.subject).toBe("Test Attachment");
    expect(detail.text?.trim()).toBe("This is plain text.");
    expect(detail.attachments.length).toBe(1);
    expect(detail.attachments[0].filename).toBe("sample.txt");
    expect(detail.attachments[0].size).toBe(11); // 'Hello World' length

    // Extract attachment
    const att = await extractAttachment(Buffer.from(rawEmail), 0);
    expect(att.filename).toBe("sample.txt");
    expect(att.content.toString("utf8")).toBe("Hello World");

    // Out-of-bounds attachment index throws 404
    await expect(extractAttachment(Buffer.from(rawEmail), 1)).rejects.toThrow();
  });

  it("validates folder, uid, and uidValidity helpers", () => {
    expect(validateFolder("INBOX")).toBe("INBOX");
    expect(validateFolder("INBOX/SubFolder")).toBe("INBOX/SubFolder");
    expect(() => validateFolder("")).toThrow();
    expect(() => validateFolder("a".repeat(256))).toThrow();
    expect(() => validateFolder("INBOX\0evil")).toThrow();

    expect(validateUid("42")).toBe(42);
    expect(validateUid(100)).toBe(100);
    expect(() => validateUid(0)).toThrow();
    expect(() => validateUid(-5)).toThrow();
    expect(() => validateUid(4294967296)).toThrow(); // > 32-bit unsigned
    expect(() => validateUid("not-a-number")).toThrow();

    expect(validateUidValidity("123456")).toBe("123456");
    expect(() => validateUidValidity("invalid")).toThrow();
    expect(() => validateUidValidity("")).toThrow();
  });
});

describe("receipt metadata selection", () => {
  async function* messages(
    values: Array<{ uid: number; internalDate?: Date | string }>,
  ) {
    yield* values;
  }

  it("selects receipt time rather than UID and normalizes mixed dates", async () => {
    expect(
      await selectLatestReceivedMessage(
        messages([
          { uid: 20, internalDate: new Date("2024-01-01T00:00:00Z") },
          { uid: 1, internalDate: "2024-01-02T01:00:00+01:00" },
        ]),
      ),
    ).toEqual({ uid: 1, receivedAt: "2024-01-02T00:00:00.000Z" });
  });

  it("breaks ties by higher UID regardless of order", async () => {
    for (const uids of [
      [1, 2],
      [2, 1],
    ]) {
      expect(
        (
          await selectLatestReceivedMessage(
            messages(
              uids.map((uid) => ({
                uid,
                internalDate: "2024-01-01T00:00:00Z",
              })),
            ),
          )
        )?.uid,
      ).toBe(2);
    }
    expect(await selectLatestReceivedMessage(messages([]))).toBeNull();
  });

  it("rejects missing or invalid dates and iterator errors", async () => {
    for (const internalDate of [undefined, "invalid"]) {
      await expect(
        selectLatestReceivedMessage(messages([{ uid: 1, internalDate }])),
      ).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });
    }
    async function* broken(): AsyncGenerator<{
      uid: number;
      internalDate?: string;
    }> {
      yield { uid: 1, internalDate: "2024-01-01T00:00:00Z" };
      throw new Error("fetch failed");
    }
    await expect(selectLatestReceivedMessage(broken())).rejects.toThrow(
      "fetch failed",
    );
  });
});
