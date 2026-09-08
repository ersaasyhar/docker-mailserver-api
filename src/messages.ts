import PostalMime, { type Address } from "postal-mime";
import { AppError } from "./app";

export interface MessageSummary {
  uid: number;
  flags: string[];
  from: Address | null;
  to: Address[];
  subject: string | null;
  date: string | null;
  size: number;
}

export interface AttachmentSummary {
  index: number;
  filename: string | null;
  mimeType: string;
  size: number;
  contentId: string | null;
}

export interface MessageDetail {
  uid: number;
  uidValidity: string;
  folder: string;
  flags: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: AttachmentSummary[];
}

export interface FolderItem {
  path: string;
  name: string;
  specialUse?: string;
}

export interface SendAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface SendMessagePayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: SendAttachment[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentCopySaved: boolean;
}

const MIME_TYPE_REGEX = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const EMAIL_ADDRESS_REGEX = /^[^\s@\0\r\n]+@[^\s@\0\r\n]+$/;

export function validateFolder(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    throw new AppError(
      "INVALID_REQUEST",
      "Folder name must be between 1 and 255 characters.",
    );
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new AppError(
      "INVALID_REQUEST",
      "Folder name contains invalid control characters.",
    );
  }
  return trimmed;
}

export function validateUid(val: unknown): number {
  let uid: number;
  if (typeof val === "number") {
    uid = val;
  } else if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    uid = Number.parseInt(val.trim(), 10);
  } else {
    throw new AppError(
      "INVALID_REQUEST",
      "Message UID must be a positive integer.",
    );
  }
  if (!Number.isInteger(uid) || uid < 1 || uid > 4294967295) {
    throw new AppError(
      "INVALID_REQUEST",
      "Message UID must be a positive 32-bit integer.",
    );
  }
  return uid;
}

export function validateUidValidity(val: unknown): string {
  if (typeof val !== "string" || !/^\d+$/.test(val.trim())) {
    throw new AppError(
      "INVALID_REQUEST",
      "UIDVALIDITY must be a valid decimal string.",
    );
  }
  return val.trim();
}

export function validateSendPayload(payload: SendMessagePayload): void {
  if (!payload || typeof payload !== "object") {
    throw new AppError("INVALID_REQUEST", "Invalid send message payload.");
  }

  const to = Array.isArray(payload.to) ? payload.to : [];
  const cc = Array.isArray(payload.cc) ? payload.cc : [];
  const bcc = Array.isArray(payload.bcc) ? payload.bcc : [];

  const totalRecipients = to.length + cc.length + bcc.length;
  if (totalRecipients < 1 || totalRecipients > 100) {
    throw new AppError(
      "INVALID_REQUEST",
      "Total recipient count across to, cc, and bcc must be between 1 and 100.",
    );
  }

  const allRecipients = [...to, ...cc, ...bcc];
  for (const r of allRecipients) {
    if (
      typeof r !== "string" ||
      !EMAIL_ADDRESS_REGEX.test(r) ||
      /[\0\r\n]/.test(r)
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        `Invalid recipient address: "${r}".`,
      );
    }
  }

  if (typeof payload.subject !== "string" || payload.subject.length > 998) {
    throw new AppError(
      "INVALID_REQUEST",
      "Subject must be a string up to 998 characters.",
    );
  }
  if (/[\0\r\n]/.test(payload.subject)) {
    throw new AppError(
      "INVALID_REQUEST",
      "Subject must not contain CR, LF, or NUL characters.",
    );
  }

  const hasText =
    typeof payload.text === "string" && payload.text.trim().length > 0;
  const hasHtml =
    typeof payload.html === "string" && payload.html.trim().length > 0;
  if (!hasText && !hasHtml) {
    throw new AppError(
      "INVALID_REQUEST",
      "Message must contain non-empty text or html content.",
    );
  }

  if (payload.attachments) {
    if (!Array.isArray(payload.attachments)) {
      throw new AppError("INVALID_REQUEST", "Attachments must be an array.");
    }
    for (const att of payload.attachments) {
      if (
        typeof att.filename !== "string" ||
        att.filename.length === 0 ||
        att.filename.length > 255
      ) {
        throw new AppError(
          "INVALID_REQUEST",
          "Attachment filename must be between 1 and 255 characters.",
        );
      }
      if (/[\0\r\n/\\:]/.test(att.filename)) {
        throw new AppError(
          "INVALID_REQUEST",
          "Attachment filename contains forbidden path or control characters.",
        );
      }
      if (
        typeof att.contentType !== "string" ||
        !MIME_TYPE_REGEX.test(att.contentType)
      ) {
        throw new AppError(
          "INVALID_REQUEST",
          "Attachment contentType must be a valid MIME token pair.",
        );
      }
      if (
        typeof att.contentBase64 !== "string" ||
        att.contentBase64.length === 0 ||
        att.contentBase64.length % 4 !== 0 ||
        !BASE64_REGEX.test(att.contentBase64)
      ) {
        throw new AppError(
          "INVALID_REQUEST",
          "Attachment contentBase64 must be valid base64.",
        );
      }
    }
  }
}

export async function parseRawEmail(
  rawBuffer: Buffer | Uint8Array,
  uid: number,
  uidValidity: string,
  folder: string,
  flags: string[],
): Promise<MessageDetail> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(rawBuffer, {
      maxNestingDepth: 32,
      maxHeadersSize: 256 * 1024,
      maxRfc822NestingDepth: 3,
    });
  } catch {
    throw new AppError("INVALID_MESSAGE", "Failed to parse message content.");
  }

  const attachments: AttachmentSummary[] = email.attachments.map(
    (att, index) => {
      let size = 0;
      if (typeof att.content === "string") {
        size = Buffer.byteLength(att.content, "utf8");
      } else if (att.content instanceof ArrayBuffer) {
        size = att.content.byteLength;
      } else if (ArrayBuffer.isView(att.content)) {
        size = att.content.byteLength;
      }
      return {
        index,
        filename: att.filename ?? null,
        mimeType: att.mimeType || "application/octet-stream",
        size,
        contentId: att.contentId ?? null,
      };
    },
  );

  return {
    uid,
    uidValidity,
    folder,
    flags,
    from: email.from ?? null,
    to: email.to ?? [],
    cc: email.cc ?? [],
    subject: email.subject ?? null,
    date: email.date ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments,
  };
}

export async function extractAttachment(
  rawBuffer: Buffer | Uint8Array,
  attachmentIndex: number,
): Promise<{ filename: string; contentType: string; content: Buffer }> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(rawBuffer, {
      maxNestingDepth: 32,
      maxHeadersSize: 256 * 1024,
      maxRfc822NestingDepth: 3,
    });
  } catch {
    throw new AppError("INVALID_MESSAGE", "Failed to parse message content.");
  }

  if (attachmentIndex < 0 || attachmentIndex >= email.attachments.length) {
    throw new AppError("NOT_FOUND", "Attachment not found.");
  }

  const att = email.attachments[attachmentIndex];
  let buf: Buffer;
  if (Buffer.isBuffer(att.content)) {
    buf = att.content;
  } else if (att.content instanceof ArrayBuffer) {
    buf = Buffer.from(att.content);
  } else if (ArrayBuffer.isView(att.content)) {
    buf = Buffer.from(
      att.content.buffer,
      att.content.byteOffset,
      att.content.byteLength,
    );
  } else if (typeof att.content === "string") {
    buf = Buffer.from(att.content, "utf8");
  } else {
    buf = Buffer.alloc(0);
  }

  const rawFilename = att.filename || `attachment-${attachmentIndex}`;
  const safeFilename = rawFilename.replace(/[\0\r\n/\\:]/g, "_");

  return {
    filename: safeFilename,
    contentType: "application/octet-stream",
    content: buf,
  };
}
