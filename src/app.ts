import crypto from "node:crypto";
import { Elysia, t } from "elysia";
import openapi from "../docs/openapi.json";
import type { AccountService } from "./accounts";
import type { Config } from "./config";
import type { MailService } from "./mail";
import { type SendMessagePayload, validateSendPayload } from "./messages";

export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "DOMAIN_FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_MAILBOX"
  | "MESSAGE_TOO_LARGE"
  | "INVALID_MESSAGE"
  | "UPSTREAM_FAILURE"
  | "UPSTREAM_UNAVAILABLE"
  | "BUSY"
  | "INTERNAL_ERROR";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "Invalid request.",
  UNAUTHORIZED: "Unauthorized.",
  DOMAIN_FORBIDDEN: "Domain is forbidden.",
  NOT_FOUND: "Resource not found.",
  CONFLICT: "Resource conflict.",
  STALE_MAILBOX: "Mailbox state is stale.",
  MESSAGE_TOO_LARGE: "Message exceeds allowed size limit.",
  INVALID_MESSAGE: "Invalid message format.",
  UPSTREAM_FAILURE: "Upstream service failure.",
  UPSTREAM_UNAVAILABLE: "Upstream service unavailable.",
  BUSY: "Service is busy. Please try again later.",
  INTERNAL_ERROR: "Internal server error.",
};

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  DOMAIN_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_MAILBOX: 409,
  MESSAGE_TOO_LARGE: 413,
  INVALID_MESSAGE: 422,
  UPSTREAM_FAILURE: 502,
  UPSTREAM_UNAVAILABLE: 503,
  BUSY: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export interface Services {
  accounts: AccountService;
  mail: MailService;
}

function verifyBearerToken(
  authHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

function getCorsHeaders(
  origin: string | null,
  allowedOrigins: string[],
): Record<string, string> | null {
  if (!origin || !allowedOrigins.includes(origin)) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function decodeEmail(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError(
      "INVALID_REQUEST",
      "Malformed URL-encoded email parameter.",
    );
  }
}

export function createApp(config: Config, services: Services): Elysia {
  const app = new Elysia();

  // onRequest hook for Auth, CORS, Security Headers, and Content-Type checking
  app.onRequest(({ request }) => {
    const origin = request.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin, config.corsOrigins);

    // Permit unauthenticated OPTIONS for exact allowed origins
    if (request.method === "OPTIONS") {
      if (corsHeaders) {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Unauthorized." },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    const pathname = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      (pathname === "/docs" ||
        pathname === "/docs/openapi.json" ||
        pathname === "/llms.txt")
    ) {
      return;
    }

    // Verify Bearer Token before parsing request bodies or upstream work
    const authHeader = request.headers.get("authorization");
    if (!verifyBearerToken(authHeader, config.adminApiToken)) {
      return new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Unauthorized." },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...(corsHeaders
              ? {
                  "Access-Control-Allow-Origin":
                    corsHeaders["Access-Control-Allow-Origin"],
                  Vary: "Origin",
                }
              : {}),
          },
        },
      );
    }

    // Enforce JSON-only mutation bodies
    const method = request.method;
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      const contentLength = request.headers.get("content-length");
      const transferEncoding = request.headers.get("transfer-encoding");
      const hasBody =
        (contentLength && Number.parseInt(contentLength, 10) > 0) ||
        transferEncoding;
      const contentType = request.headers.get("content-type") || "";

      if (
        hasBody &&
        !contentType.toLowerCase().startsWith("application/json")
      ) {
        return new Response(
          JSON.stringify({
            error: { code: "INVALID_REQUEST", message: "Invalid request." },
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              ...(corsHeaders
                ? {
                    "Access-Control-Allow-Origin":
                      corsHeaders["Access-Control-Allow-Origin"],
                    Vary: "Origin",
                  }
                : {}),
            },
          },
        );
      }
    }
  });

  // onAfterHandle to ensure standard security and CORS headers on all successful responses
  app.onAfterHandle(({ request, set }) => {
    set.headers["cache-control"] = "no-store";
    set.headers["x-content-type-options"] = "nosniff";

    const origin = request.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin, config.corsOrigins);
    if (corsHeaders) {
      set.headers["access-control-allow-origin"] =
        corsHeaders["Access-Control-Allow-Origin"];
      set.headers.vary = "Origin";
    }
  });

  // Global error handler
  app.onError(({ error, code, set, request }) => {
    set.headers["cache-control"] = "no-store";
    set.headers["x-content-type-options"] = "nosniff";

    const origin = request.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin, config.corsOrigins);
    if (corsHeaders) {
      set.headers["access-control-allow-origin"] =
        corsHeaders["Access-Control-Allow-Origin"];
      set.headers.vary = "Origin";
    }

    if (error instanceof AppError) {
      set.status = error.status;
      return {
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }

    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      return {
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid request.",
        },
      };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        error: {
          code: "NOT_FOUND",
          message: "Resource not found.",
        },
      };
    }

    set.status = 500;
    return {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    };
  });

  // Health check endpoint (authenticated liveness check)
  app.get("/health", () => {
    return { status: "ok" };
  });
  app.get("/docs/openapi.json", () => openapi);
  app.get(
    "/docs",
    () =>
      new Response(
        Bun.file(new URL("../docs/agent-usage.md", import.meta.url)),
        {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      ),
  );
  app.get(
    "/llms.txt",
    () =>
      new Response(Bun.file(new URL("../docs/llms.txt", import.meta.url)), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }),
  );

  // -------------------------------------------------------------
  // Account CRUD Routes: /v1/accounts
  // -------------------------------------------------------------
  app.group("/v1/accounts", (acc) =>
    acc
      // GET /v1/accounts
      .get("/", async () => {
        const items = await services.accounts.listAccounts();
        return { items };
      })
      // POST /v1/accounts
      .post(
        "/",
        async ({ body, set }) => {
          const result = await services.accounts.createAccount(
            body.email,
            body.password,
          );
          set.status = 201;
          return result;
        },
        {
          body: t.Object({
            email: t.String(),
            password: t.String(),
          }),
        },
      )
      // GET /v1/accounts/:email
      .get("/:email", async ({ params }) => {
        const email = decodeEmail(params.email);
        return await services.accounts.getAccount(email);
      })
      // PATCH /v1/accounts/:email
      .patch(
        "/:email",
        async ({ params, body }) => {
          const email = decodeEmail(params.email);
          return await services.accounts.updatePassword(email, body.password);
        },
        {
          body: t.Object({
            password: t.String(),
          }),
        },
      )
      // DELETE /v1/accounts/:email
      .delete(
        "/:email",
        async ({ params, body, set }) => {
          const email = decodeEmail(params.email);
          await services.accounts.deleteAccount(email, {
            confirmEmail: body.confirmEmail,
            purge: body.purge,
          });
          set.status = 204;
          return;
        },
        {
          body: t.Object({
            confirmEmail: t.String(),
            purge: t.Boolean(),
          }),
        },
      )
      // -----------------------------------------------------------
      // Mailbox & Message Routes: /v1/accounts/:email/...
      // -----------------------------------------------------------
      // GET /v1/accounts/:email/folders
      .get("/:email/folders", async ({ params }) => {
        const email = decodeEmail(params.email);
        const items = await services.mail.listFolders(email);
        return { items };
      })
      // GET /v1/accounts/:email/messages
      .get("/:email/messages", async ({ params, query }) => {
        const email = decodeEmail(params.email);
        const folder = query.folder?.trim() || "INBOX";
        const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;
        const beforeUid = query.beforeUid
          ? Number.parseInt(query.beforeUid, 10)
          : undefined;
        const uidValidity = query.uidValidity?.trim();

        return await services.mail.listMessages(email, {
          folder,
          limit,
          beforeUid,
          uidValidity,
        });
      })
      // GET /v1/accounts/:email/messages/latest
      .get("/:email/messages/latest", async ({ params, query, set }) => {
        const email = decodeEmail(params.email);
        const folder = query.folder?.trim() || "INBOX";
        const page = await services.mail.listMessages(email, {
          folder,
          limit: 1,
        });
        if (page.items.length === 0) {
          set.status = 204;
          return;
        }
        return await services.mail.getMessage(email, page.items[0].uid, {
          folder: page.folder,
          uidValidity: page.uidValidity,
        });
      })
      // GET /v1/accounts/:email/messages/:uid
      .get("/:email/messages/:uid", async ({ params, query }) => {
        const email = decodeEmail(params.email);
        const folder = query.folder?.trim() || "INBOX";
        const uidValidity = query.uidValidity?.trim() || "";
        const uid = Number.parseInt(params.uid, 10);

        return await services.mail.getMessage(email, uid, {
          folder,
          uidValidity,
        });
      })
      // GET /v1/accounts/:email/messages/:uid/attachments/:index
      .get(
        "/:email/messages/:uid/attachments/:index",
        async ({ params, query, set }) => {
          const email = decodeEmail(params.email);
          const folder = query.folder?.trim() || "INBOX";
          const uidValidity = query.uidValidity?.trim() || "";
          const uid = Number.parseInt(params.uid, 10);
          const index = Number.parseInt(params.index, 10);

          const attachment = await services.mail.getAttachment(
            email,
            uid,
            index,
            {
              folder,
              uidValidity,
            },
          );

          set.headers["content-type"] = "application/octet-stream";
          set.headers["content-disposition"] =
            `attachment; filename="${encodeURIComponent(attachment.filename)}"`;
          set.headers["x-content-type-options"] = "nosniff";

          return new Response(new Uint8Array(attachment.content), {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            },
          });
        },
      )
      // PATCH /v1/accounts/:email/messages/:uid
      .patch(
        "/:email/messages/:uid",
        async ({ params, query, body }) => {
          const email = decodeEmail(params.email);
          const folder = query.folder?.trim() || "INBOX";
          const uidValidity = query.uidValidity?.trim() || "";
          const uid = Number.parseInt(params.uid, 10);

          return await services.mail.updateFlags(
            email,
            uid,
            { seen: body.seen, flagged: body.flagged },
            { folder, uidValidity },
          );
        },
        {
          body: t.Object({
            seen: t.Optional(t.Boolean()),
            flagged: t.Optional(t.Boolean()),
          }),
        },
      )
      // POST /v1/accounts/:email/messages/:uid/move
      .post(
        "/:email/messages/:uid/move",
        async ({ params, query, body }) => {
          const email = decodeEmail(params.email);
          const folder = query.folder?.trim() || "INBOX";
          const uidValidity = query.uidValidity?.trim() || "";
          const uid = Number.parseInt(params.uid, 10);

          if (body.destination !== "archive" && body.destination !== "trash") {
            throw new AppError(
              "INVALID_REQUEST",
              "Destination must be 'archive' or 'trash'.",
            );
          }

          return await services.mail.moveMessage(email, uid, body.destination, {
            folder,
            uidValidity,
          });
        },
        {
          body: t.Object({
            destination: t.Union([t.Literal("archive"), t.Literal("trash")]),
          }),
        },
      )
      // DELETE /v1/accounts/:email/messages/:uid
      .delete("/:email/messages/:uid", async ({ params, query, set }) => {
        const email = decodeEmail(params.email);
        const folder = query.folder?.trim() || "INBOX";
        const uidValidity = query.uidValidity?.trim() || "";
        const uid = Number.parseInt(params.uid, 10);

        await services.mail.deleteMessage(email, uid, {
          folder,
          uidValidity,
        });
        set.status = 204;
        return;
      })
      // POST /v1/accounts/:email/messages/send
      .post(
        "/:email/messages/send",
        async ({ params, body }) => {
          const email = decodeEmail(params.email);
          validateSendPayload(body as SendMessagePayload);
          return await services.mail.sendMessage(
            email,
            body as SendMessagePayload,
          );
        },
        {
          body: t.Object({
            to: t.Array(t.String()),
            cc: t.Optional(t.Array(t.String())),
            bcc: t.Optional(t.Array(t.String())),
            subject: t.String(),
            text: t.Optional(t.String()),
            html: t.Optional(t.String()),
            attachments: t.Optional(
              t.Array(
                t.Object({
                  filename: t.String(),
                  contentType: t.String(),
                  contentBase64: t.String(),
                }),
              ),
            ),
          }),
        },
      ),
  );

  return app;
}
