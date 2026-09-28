import "server-only";

/**
 * Shared plumbing for the mobile-facing API.
 *
 * The Expo client is a different origin from this server, so every route it
 * touches needs CORS. It is also a client we do not control the release cycle
 * of: once a build is on someone's phone it keeps calling whatever it was
 * compiled against, which is why errors here are shaped consistently
 * (`{ error }`) rather than left to each route's improvisation.
 */

const CORS_HEADERS: Record<string, string> = {
  // The app ships as a native binary and an Expo web export, neither of which
  // has a stable origin to allow-list. These routes are public reads and
  // unsigned transaction builders — nothing here is authorised by origin, and
  // every transaction is signed and sent by a key this server never sees.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-juno-index-secret",
  "Access-Control-Max-Age": "86400",
};

export function junoJson(body: unknown, init: ResponseInit = {}): Response {
  return new Response(
    JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    {
      ...init,
      headers: {
        "content-type": "application/json",
        ...CORS_HEADERS,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    },
  );
}

export function junoError(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return junoJson({ error: message, ...extra }, { status });
}

/** Preflight. Every mobile route re-exports this. */
export function junoOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * An error the caller caused and can fix — bad input, or a request the chain
 * will not honour ("this market moved to Uniswap").
 *
 * A class rather than a pattern match on the message: the distinction matters
 * on a phone, where a 400 is worth showing the user and a 500 is worth
 * retrying, so it is stated at the throw site, not guessed at the catch site.
 * `extra` rides along in the JSON body (e.g. `retryAfterSeconds`).
 */
export class CallerError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(message: string, status = 400, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "CallerError";
    this.status = status;
    this.extra = extra;
  }
}

/** A public-RPC refusal, as opposed to a fault in this server. */
export function isRpcBusy(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error ?? "");
  return /429|rate limit|Too Many Requests|503|exceeded|capacity|timed out|took too long/i.test(message);
}

/**
 * Run a read-only build again when the RPC refused it. Only for work that
 * sends nothing: a retried build is a new unsigned transaction, never a
 * second send.
 */
export async function retryWhenBusy<T>(run: () => Promise<T>, delays = [1_200, 2_500]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CallerError) throw error;
      if (attempt >= delays.length || !isRpcBusy(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** `junoHandler` for a read: a brief RPC refusal is waited out instead of answered with a 503. */
export function junoRead(run: () => Promise<Response>): Promise<Response> {
  return junoHandler(() => retryWhenBusy(run));
}

/** Run a handler, turning a thrown error into a clean 4xx/5xx. */
export async function junoHandler(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CallerError) {
      return junoError(error.message, error.status, error.extra);
    }
    // A throttled chain read is not a server fault and must not read like one.
    if (isRpcBusy(error)) {
      console.warn("[juno rpc busy]", error instanceof Error ? error.message : error);
      return junoError("The Arbitrum RPC is rate-limiting us right now. Try again in a moment.", 503);
    }
    // Ours. Log it with the stack; never leak internals to the client.
    console.error("[juno api]", error);
    return junoError("Something went wrong on our side. Try again.", 500);
  }
}

/** Read and validate a JSON body without trusting its shape. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    const body = (await request.json()) as T;
    if (body === null || typeof body !== "object") throw new Error("not an object");
    return body;
  } catch {
    throw new CallerError("Invalid JSON body");
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CallerError(`"${field}" is required`);
  }
  return value.trim();
}

export function requireNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) {
    throw new CallerError(`"${field}" must be a number`);
  }
  return n;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
