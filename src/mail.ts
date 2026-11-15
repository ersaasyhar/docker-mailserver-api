import fs from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer, { type SentMessageInfo } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { KeyedMutex } from "./accounts";
import { AppError } from "./app";
import type { Config } from "./config";
import {
  extractAttachment,
  type FolderItem,
  type MessageDetail,
  type MessageSummary,
  parseRawEmail,
  type SendMessagePayload,
  type SendResult,
  validateFolder,
  validateSendPayload,
  validateUid,
  validateUidValidity,
} from "./messages";

export interface ReceivedMessageCoordinate {
  uid: number;
  receivedAt: string;
}

export interface LatestReceivedMessage extends ReceivedMessageCoordinate {
  folder: string;
  uidValidity: string;
}

export async function selectLatestReceivedMessage(
  messages: AsyncIterable<{ uid: number; internalDate?: Date | string }>,
): Promise<ReceivedMessageCoordinate | null> {
  let winner: ReceivedMessageCoordinate | null = null;
  let latest = -Infinity;
  for await (const message of messages) {
    const timestamp =
      message.internalDate instanceof Date
        ? message.internalDate.getTime()
        : Date.parse(message.internalDate ?? "");
    if (!Number.isFinite(timestamp)) {
      throw new AppError(
        "UPSTREAM_FAILURE",
        "Message receipt time is unavailable.",
      );
    }
    if (
      timestamp > latest ||
      (timestamp === latest && message.uid > (winner?.uid ?? -Infinity))
    ) {
      latest = timestamp;
      winner = {
        uid: message.uid,
        receivedAt: new Date(timestamp).toISOString(),
      };
    }
  }
  return winner;
}

export interface MailService {
  listFolders(email: string): Promise<FolderItem[]>;
  findLatestReceivedMessage(
    email: string,
    folder: string,
  ): Promise<LatestReceivedMessage | null>;
  listMessages(
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
  }>;
  getMessage(
    email: string,
    uid: number,
    params: { folder: string; uidValidity: string },
  ): Promise<MessageDetail>;
  getAttachment(
    email: string,
    uid: number,
    index: number,
    params: { folder: string; uidValidity: string },
  ): Promise<{ filename: string; contentType: string; content: Buffer }>;
  updateFlags(
    email: string,
    uid: number,
    flags: { seen?: boolean; flagged?: boolean },
    params: { folder: string; uidValidity: string },
  ): Promise<{
    uid: number;
    uidValidity: string;
    folder: string;
    flags: string[];
  }>;
  moveMessage(
    email: string,
    uid: number,
    destination: "archive" | "trash",
    params: { folder: string; uidValidity: string },
  ): Promise<{ moved: boolean; destination: string }>;
  deleteMessage(
    email: string,
    uid: number,
    params: { folder: string; uidValidity: string },
  ): Promise<void>;
  sendMessage(email: string, payload: SendMessagePayload): Promise<SendResult>;
}

export interface DefaultMailServiceOptions {
  config: Config;
  accountKeyedLock: KeyedMutex;
}

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MiB
const MAX_CONCURRENT_MAIL_OPERATIONS = 4;

export class DefaultMailService implements MailService {
  private readonly config: Config;
  private readonly keyedLock: KeyedMutex;
  private activeOperations = 0;
  private readonly caBuffer?: Buffer;

  constructor(options: DefaultMailServiceOptions) {
    this.config = options.config;
    this.keyedLock = options.accountKeyedLock;
    if (this.config.mailTlsCaFile) {
      try {
        this.caBuffer = fs.readFileSync(this.config.mailTlsCaFile);
      } catch {
        // Ignored, handled in config load
      }
    }
  }

  private async withImapClient<T>(
    email: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    if (this.activeOperations >= MAX_CONCURRENT_MAIL_OPERATIONS) {
      throw new AppError("BUSY", "Service is busy. Please try again later.");
    }
    this.activeOperations++;

    try {
      return await this.keyedLock.runExclusive(email, async () => {
        const client = new ImapFlow({
          host: this.config.imapHost,
          port: this.config.imapPort,
          secure: true,
          auth: {
            user: `${email}*${this.config.imapMasterUser}`,
            pass: this.config.imapMasterPassword,
          },
          tls: {
            minVersion: "TLSv1.2",
            servername: this.config.mailTlsServername,
            ca: this.caBuffer,
          },
          logger: false,
          emitLogs: false,
          connectionTimeout: 15_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
        });

        try {
          await client.connect();
        } catch {
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            "Failed to connect to IMAP server.",
          );
        }

        try {
          return await fn(client);
        } finally {
          try {
            await client.logout();
          } catch {
            client.close();
          }
        }
      });
    } finally {
      this.activeOperations--;
    }
  }

  async listFolders(email: string): Promise<FolderItem[]> {
    return this.withImapClient(email, async (client) => {
      let listResult: Awaited<ReturnType<typeof client.list>>;
      try {
        listResult = await client.list();
      } catch {
        throw new AppError("UPSTREAM_FAILURE", "Failed to list mail folders.");
      }

      const items: FolderItem[] = [];
      for (const folder of listResult) {
        // Exclude nonselectable entries
        if (folder.flags?.has("\\Noselect")) {
          continue;
        }
        items.push({
          path: folder.path,
          name: folder.name,
          specialUse: folder.specialUse,
        });
      }
      return items;
    });
  }

  async findLatestReceivedMessage(
    email: string,
    folder: string,
  ): Promise<LatestReceivedMessage | null> {
    const validFolder = validateFolder(folder);
    return this.withImapClient(email, async (client) => {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }
      try {
        if (!client.mailbox)
          throw new AppError("NOT_FOUND", "Folder not found.");
        const uidValidity = client.mailbox.uidValidity.toString();
        if (client.mailbox.exists === 0) return null;
        try {
          const winner = await selectLatestReceivedMessage(
            client.fetch("1:*", { uid: true, internalDate: true }),
          );
          if (!winner)
            throw new AppError(
              "UPSTREAM_FAILURE",
              "Failed to fetch message receipt times.",
            );
          return { ...winner, folder: validFolder, uidValidity };
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            "UPSTREAM_FAILURE",
            "Failed to fetch message receipt times.",
          );
        }
      } finally {
        lock.release();
      }
    });
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
    const validFolder = validateFolder(params.folder);
    const limit = Math.max(1, Math.min(100, params.limit));

    return this.withImapClient(email, async (client) => {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();

        if (params.beforeUid !== undefined) {
          if (!params.uidValidity) {
            throw new AppError(
              "INVALID_REQUEST",
              "uidValidity query parameter is required when paging with beforeUid.",
            );
          }
          if (params.uidValidity !== currentUidValidity) {
            throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
          }
        }

        // ponytail: single-admin baseline searches UID indexes; server-side paging is future enhancement.
        if (params.beforeUid !== undefined && params.beforeUid <= 1) {
          return {
            folder: validFolder,
            uidValidity: currentUidValidity,
            items: [],
            nextBeforeUid: null,
          };
        }

        const searchCriteria =
          params.beforeUid !== undefined
            ? { uid: `1:${params.beforeUid - 1}` }
            : { all: true };

        let uids: number[] | false | undefined;
        try {
          uids = await client.search(searchCriteria, { uid: true });
        } catch {
          throw new AppError("UPSTREAM_FAILURE", "Failed to search mailbox.");
        }

        if (!uids || uids.length === 0) {
          return {
            folder: validFolder,
            uidValidity: currentUidValidity,
            items: [],
            nextBeforeUid: null,
          };
        }

        const sortedUids = [...uids].sort((a, b) => b - a);
        const slicedUids = sortedUids.slice(0, limit);
        const hasMore = sortedUids.length > limit;
        const nextBeforeUid = hasMore
          ? slicedUids[slicedUids.length - 1]
          : null;

        const uidQuery = slicedUids.join(",");
        const items: MessageSummary[] = [];

        try {
          for await (const msg of client.fetch(
            uidQuery,
            { envelope: true, flags: true, internalDate: true, size: true },
            { uid: true },
          )) {
            items.push({
              uid: msg.uid,
              flags: Array.from(msg.flags ?? []),
              from: (msg.envelope?.from?.[0] as MessageSummary["from"]) ?? null,
              to: (msg.envelope?.to as MessageSummary["to"]) ?? [],
              subject: msg.envelope?.subject ?? null,
              date:
                msg.internalDate instanceof Date
                  ? msg.internalDate.toISOString()
                  : typeof msg.internalDate === "string"
                    ? msg.internalDate
                    : null,
              size: msg.size ?? 0,
            });
          }
        } catch {
          throw new AppError(
            "UPSTREAM_FAILURE",
            "Failed to fetch message summaries.",
          );
        }

        items.sort((a, b) => b.uid - a.uid);

        return {
          folder: validFolder,
          uidValidity: currentUidValidity,
          items,
          nextBeforeUid,
        };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(
    email: string,
    uid: number,
    params: { folder: string; uidValidity: string },
  ): Promise<MessageDetail> {
    const validFolder = validateFolder(params.folder);
    const validUid = validateUid(uid);
    const expectedUidValidity = validateUidValidity(params.uidValidity);

    return this.withImapClient(email, async (client) => {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();
        if (currentUidValidity !== expectedUidValidity) {
          throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
        }

        const meta = await client.fetchOne(
          String(validUid),
          { size: true, flags: true },
          { uid: true },
        );
        if (!meta) {
          throw new AppError("NOT_FOUND", "Message not found.");
        }

        if (meta.size && meta.size > MAX_MESSAGE_SIZE) {
          throw new AppError(
            "MESSAGE_TOO_LARGE",
            "Message size exceeds 10 MiB limit.",
          );
        }

        const downloaded = await client.download(String(validUid), undefined, {
          uid: true,
          maxBytes: MAX_MESSAGE_SIZE,
        });
        if (!downloaded?.content) {
          throw new AppError("NOT_FOUND", "Message body not found.");
        }

        const chunks: Buffer[] = [];
        for await (const chunk of downloaded.content) {
          chunks.push(Buffer.from(chunk));
        }
        const rawBuffer = Buffer.concat(chunks);
        if (rawBuffer.byteLength > MAX_MESSAGE_SIZE) {
          throw new AppError(
            "MESSAGE_TOO_LARGE",
            "Message size exceeds 10 MiB limit.",
          );
        }

        return await parseRawEmail(
          rawBuffer,
          validUid,
          currentUidValidity,
          validFolder,
          Array.from(meta.flags ?? []),
        );
      } finally {
        lock.release();
      }
    });
  }

  async getAttachment(
    email: string,
    uid: number,
    index: number,
    params: { folder: string; uidValidity: string },
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const validFolder = validateFolder(params.folder);
    const validUid = validateUid(uid);
    const expectedUidValidity = validateUidValidity(params.uidValidity);

    return this.withImapClient(email, async (client) => {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();
        if (currentUidValidity !== expectedUidValidity) {
          throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
        }

        const meta = await client.fetchOne(
          String(validUid),
          { size: true },
          { uid: true },
        );
        if (!meta) {
          throw new AppError("NOT_FOUND", "Message not found.");
        }
        if (meta.size && meta.size > MAX_MESSAGE_SIZE) {
          throw new AppError(
            "MESSAGE_TOO_LARGE",
            "Message size exceeds 10 MiB limit.",
          );
        }

        const downloaded = await client.download(String(validUid), undefined, {
          uid: true,
          maxBytes: MAX_MESSAGE_SIZE,
        });
        if (!downloaded?.content) {
          throw new AppError("NOT_FOUND", "Message body not found.");
        }

        const chunks: Buffer[] = [];
        for await (const chunk of downloaded.content) {
          chunks.push(Buffer.from(chunk));
        }
        const rawBuffer = Buffer.concat(chunks);
        if (rawBuffer.byteLength > MAX_MESSAGE_SIZE) {
          throw new AppError(
            "MESSAGE_TOO_LARGE",
            "Message size exceeds 10 MiB limit.",
          );
        }

        return await extractAttachment(rawBuffer, index);
      } finally {
        lock.release();
      }
    });
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
    if (flags.seen === undefined && flags.flagged === undefined) {
      throw new AppError(
        "INVALID_REQUEST",
        "At least one flag (seen or flagged) must be specified.",
      );
    }

    const validFolder = validateFolder(params.folder);
    const validUid = validateUid(uid);
    const expectedUidValidity = validateUidValidity(params.uidValidity);

    return this.withImapClient(email, async (client) => {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();
        if (currentUidValidity !== expectedUidValidity) {
          throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
        }

        const exists = await client.fetchOne(
          String(validUid),
          { flags: true },
          { uid: true },
        );
        if (!exists) {
          throw new AppError("NOT_FOUND", "Message not found.");
        }

        if (flags.seen === true) {
          await client.messageFlagsAdd(String(validUid), ["\\Seen"], {
            uid: true,
          });
        } else if (flags.seen === false) {
          await client.messageFlagsRemove(String(validUid), ["\\Seen"], {
            uid: true,
          });
        }

        if (flags.flagged === true) {
          await client.messageFlagsAdd(String(validUid), ["\\Flagged"], {
            uid: true,
          });
        } else if (flags.flagged === false) {
          await client.messageFlagsRemove(String(validUid), ["\\Flagged"], {
            uid: true,
          });
        }

        const updated = await client.fetchOne(
          String(validUid),
          { flags: true },
          { uid: true },
        );
        const resultFlags =
          typeof updated === "object" && updated
            ? Array.from(updated.flags ?? []).map(String)
            : [];

        return {
          uid: validUid,
          uidValidity: currentUidValidity,
          folder: validFolder,
          flags: resultFlags,
        };
      } finally {
        lock.release();
      }
    });
  }

  private async resolveOrCreateFolder(
    client: ImapFlow,
    specialUseName: "\\Archive" | "\\Trash" | "\\Sent",
    defaultName: string,
  ): Promise<string> {
    const list = await client.list();
    const found = list.find(
      (f) => f.specialUse?.toLowerCase() === specialUseName.toLowerCase(),
    );
    if (found) {
      return found.path;
    }

    const named = list.find(
      (f) => f.name.toLowerCase() === defaultName.toLowerCase(),
    );
    if (named) {
      return named.path;
    }

    try {
      await client.mailboxCreate(defaultName);
      return defaultName;
    } catch {
      const refreshed = await client.list();
      const refound = refreshed.find(
        (f) =>
          f.specialUse?.toLowerCase() === specialUseName.toLowerCase() ||
          f.name.toLowerCase() === defaultName.toLowerCase(),
      );
      if (refound) {
        return refound.path;
      }
      throw new AppError(
        "UPSTREAM_FAILURE",
        `Failed to resolve or create ${defaultName} folder.`,
      );
    }
  }

  async moveMessage(
    email: string,
    uid: number,
    destination: "archive" | "trash",
    params: { folder: string; uidValidity: string },
  ): Promise<{ moved: boolean; destination: string }> {
    const validFolder = validateFolder(params.folder);
    const validUid = validateUid(uid);
    const expectedUidValidity = validateUidValidity(params.uidValidity);

    return this.withImapClient(email, async (client) => {
      if (!client.capabilities.has("MOVE")) {
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "IMAP server does not support MOVE capability.",
        );
      }

      const specialName = destination === "archive" ? "\\Archive" : "\\Trash";
      const defaultName = destination === "archive" ? "Archive" : "Trash";
      const targetFolder = await this.resolveOrCreateFolder(
        client,
        specialName,
        defaultName,
      );

      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();
        if (currentUidValidity !== expectedUidValidity) {
          throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
        }

        const exists = await client.fetchOne(
          String(validUid),
          { flags: true },
          { uid: true },
        );
        if (!exists) {
          throw new AppError("NOT_FOUND", "Message not found.");
        }

        await client.messageMove(String(validUid), targetFolder, { uid: true });
        return { moved: true, destination: targetFolder };
      } finally {
        lock.release();
      }
    });
  }

  async deleteMessage(
    email: string,
    uid: number,
    params: { folder: string; uidValidity: string },
  ): Promise<void> {
    const validFolder = validateFolder(params.folder);
    const validUid = validateUid(uid);
    const expectedUidValidity = validateUidValidity(params.uidValidity);

    await this.withImapClient(email, async (client) => {
      const trashFolder = await this.resolveOrCreateFolder(
        client,
        "\\Trash",
        "Trash",
      );

      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(validFolder);
      } catch {
        throw new AppError("NOT_FOUND", "Folder not found.");
      }

      try {
        if (!client.mailbox) {
          throw new AppError("NOT_FOUND", "Folder not found.");
        }
        const currentUidValidity = client.mailbox.uidValidity.toString();
        if (currentUidValidity !== expectedUidValidity) {
          throw new AppError("STALE_MAILBOX", "Mailbox state is stale.");
        }

        const exists = await client.fetchOne(
          String(validUid),
          { flags: true },
          { uid: true },
        );
        if (!exists) {
          throw new AppError("NOT_FOUND", "Message not found.");
        }

        if (validFolder === trashFolder) {
          // Already in trash, return without error or purge
          return;
        }

        if (!client.capabilities.has("MOVE")) {
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            "IMAP server does not support MOVE capability.",
          );
        }

        await client.messageMove(String(validUid), trashFolder, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async sendMessage(
    email: string,
    payload: SendMessagePayload,
  ): Promise<SendResult> {
    validateSendPayload(payload);

    return this.withImapClient(email, async (client) => {
      // 1. Resolve or create Sent folder before submitting
      const sentFolder = await this.resolveOrCreateFolder(
        client,
        "\\Sent",
        "Sent",
      );

      // 2. Build MIME message using MailComposer
      const attachments = payload.attachments?.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        content: Buffer.from(att.contentBase64, "base64"),
      }));

      const composer = new MailComposer({
        from: email,
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        attachments,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      let rawMime: Buffer;
      try {
        rawMime = await composer.compile().build();
      } catch {
        throw new AppError(
          "INVALID_MESSAGE",
          "Failed to construct MIME message.",
        );
      }

      if (rawMime.byteLength > MAX_MESSAGE_SIZE) {
        throw new AppError(
          "MESSAGE_TOO_LARGE",
          "Compiled message exceeds 10 MiB limit.",
        );
      }

      // 3. Submit to SMTP with explicit envelope including bcc
      const transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: false, // 587 uses STARTTLS
        requireTLS: true,
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPassword,
        },
        tls: {
          minVersion: "TLSv1.2",
          servername: this.config.mailTlsServername,
          ca: this.caBuffer,
        },
      });

      const allRecipients = [
        ...payload.to,
        ...(payload.cc ?? []),
        ...(payload.bcc ?? []),
      ];

      let sendInfo: SentMessageInfo;
      try {
        sendInfo = await transporter.sendMail({
          envelope: {
            from: email,
            to: allRecipients,
          },
          raw: rawMime,
        });
      } catch (err: unknown) {
        const errMessage = String(err).toLowerCase();
        if (
          errMessage.includes("data") ||
          errMessage.includes("timeout") ||
          errMessage.includes("closed")
        ) {
          throw new AppError(
            "UPSTREAM_FAILURE",
            "SMTP submission failed; message delivery status is uncertain.",
          );
        }
        throw new AppError(
          "UPSTREAM_FAILURE",
          "Upstream SMTP server failed to accept message.",
        );
      }

      const accepted = (sendInfo.accepted ?? []).map(String);
      const rejected = (sendInfo.rejected ?? []).map(String);

      if (accepted.length === 0) {
        throw new AppError(
          "UPSTREAM_FAILURE",
          "All recipients were rejected by the SMTP server.",
        );
      }

      // 4. Save copy to Sent mailbox in IMAP
      let sentCopySaved = false;
      try {
        await client.append(sentFolder, rawMime, ["\\Seen"]);
        sentCopySaved = true;
      } catch {
        sentCopySaved = false;
      }

      return {
        messageId: sendInfo.messageId ?? "",
        accepted,
        rejected,
        sentCopySaved,
      };
    });
  }
}
