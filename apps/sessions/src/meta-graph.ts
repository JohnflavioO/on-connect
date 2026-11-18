/**
 * Minimal client of Meta's Graph API for the WhatsApp Cloud API: what phase
 * 1 needs (check a number, send, fetch received media). The token goes only
 * to Meta hosts and is never logged; errors keep Meta's code, not the body.
 */

export interface MetaPhoneNumber {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

export interface MetaMediaInfo {
  url: string;
  mimetype: string | null;
  fileSize: number | null;
}

/** Body of POST /{phone-number-id}/messages, without the common fields. */
export type MetaOutgoing =
  | { type: "text"; text: { body: string; preview_url: boolean } }
  | { type: "image"; image: { link: string; caption?: string } }
  | { type: "video"; video: { link: string; caption?: string } }
  | { type: "audio"; audio: { link: string } }
  | { type: "document"; document: { link: string; filename?: string; caption?: string } };

export interface MetaGraph {
  phoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber>;
  /** Embedded Signup: makes the customer's account send its webhooks to this app. */
  subscribeApp(wabaId: string): Promise<void>;
  /** Embedded Signup: puts the number on the Cloud API; `pin` becomes its two-step PIN. */
  registerPhone(phoneNumberId: string, pin: string): Promise<void>;
  /** The WhatsApp message id (wamid) Meta assigned. */
  sendMessage(phoneNumberId: string, to: string, message: MetaOutgoing): Promise<string>;
  mediaInfo(mediaId: string): Promise<MetaMediaInfo>;
  /** The file at a media URL from mediaInfo; null when larger than maxBytes. */
  downloadMedia(url: string, maxBytes: number): Promise<Buffer | null>;
}

/**
 * Meta answered with an error. `retryable` is true for throttling and
 * server-side failures; anything else (bad number, closed 24 h window,
 * permissions) will fail again and should not be retried.
 */
export class MetaApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  /** e.g. "meta_131047": what the integrator sees as the message error code. */
  get errorCode(): string {
    return this.code === null ? `meta_http_${this.httpStatus}` : `meta_${this.code}`;
  }
}

/** Throttling and transient codes from Meta's error reference. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

/** Media URLs from Meta are on these hosts; the token is sent nowhere else. */
const MEDIA_HOSTS = [".fbsbx.com", ".facebook.com", ".whatsapp.net", ".fbcdn.net"];

export function createMetaGraph(options: {
  token: string;
  version: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): MetaGraph {
  const base = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch = options.fetch ?? fetch;
  const auth = { authorization: `Bearer ${options.token}` };

  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${base}/${options.version}/${path}`, {
        method: init.method ?? "GET",
        headers: { ...auth, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      // Network failure or timeout: worth another attempt.
      throw new MetaApiError(0, null, true, error instanceof Error ? error.message : "request failed");
    }
    const body = await response.json().catch(() => null) as
      | { error?: { code?: number; message?: string; error_data?: { details?: string } } }
      | null;
    if (!response.ok) {
      const code = typeof body?.error?.code === "number" ? body.error.code : null;
      const retryable = response.status === 429 || response.status >= 500 || (code !== null && RETRYABLE_CODES.has(code));
      const message = [body?.error?.message, body?.error?.error_data?.details].filter(Boolean).join(": ");
      throw new MetaApiError(response.status, code, retryable, message || `HTTP ${response.status}`);
    }
    return body as T;
  };

  return {
    async phoneNumber(phoneNumberId) {
      const body = await call<{
        display_phone_number?: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string;
      }>(`${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`);
      return {
        displayPhoneNumber: body.display_phone_number ?? null,
        verifiedName: body.verified_name ?? null,
        qualityRating: body.quality_rating ?? null,
        messagingLimitTier: body.messaging_limit_tier ?? null,
      };
    },

    async subscribeApp(wabaId) {
      await call(`${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", body: {} });
    },

    async registerPhone(phoneNumberId, pin) {
      await call(`${encodeURIComponent(phoneNumberId)}/register`, {
        method: "POST", body: { messaging_product: "whatsapp", pin },
      });
    },

    async sendMessage(phoneNumberId, to, message) {
      const body = await call<{ messages?: Array<{ id?: string }> }>(`${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        body: { messaging_product: "whatsapp", recipient_type: "individual", to, ...message },
      });
      const id = body.messages?.[0]?.id;
      if (!id) throw new MetaApiError(200, null, false, "Meta accepted the message without an id");
      return id;
    },

    async mediaInfo(mediaId) {
      const body = await call<{ url?: string; mime_type?: string; file_size?: number }>(encodeURIComponent(mediaId));
      if (!body.url) throw new MetaApiError(200, null, false, "Media has no URL");
      return { url: body.url, mimetype: body.mime_type ?? null, fileSize: body.file_size ?? null };
    },

    async downloadMedia(url, maxBytes) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !MEDIA_HOSTS.some((host) => parsed.hostname.endsWith(host))) {
        throw new MetaApiError(0, null, false, "Media URL is not on a Meta host");
      }
      const response = await doFetch(parsed, { headers: auth, signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!response.ok || !response.body) throw new MetaApiError(response.status, null, response.status >= 500, "Media download failed");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) return null;
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  };
}

/**
 * Embedded Signup: swaps the code the customer's browser received (valid 5
 * minutes, single use) for the customer's business token. Server to server;
 * the app secret goes only to Meta and is never logged.
 */
export async function exchangeMetaCode(options: {
  appId: string;
  appSecret: string;
  code: string;
  version: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<string> {
  const base = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const url = new URL(`${base}/${options.version}/oauth/access_token`);
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("client_secret", options.appSecret);
  url.searchParams.set("code", options.code);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  } catch (error) {
    throw new MetaApiError(0, null, true, error instanceof Error ? error.message : "request failed");
  }
  const body = await response.json().catch(() => null) as
    | { access_token?: string; error?: { code?: number; message?: string } }
    | null;
  if (!response.ok || typeof body?.access_token !== "string" || body.access_token.length < 20) {
    const code = typeof body?.error?.code === "number" ? body.error.code : null;
    throw new MetaApiError(response.status, code, false, body?.error?.message ?? "Code exchange failed");
  }
  return body.access_token;
}
