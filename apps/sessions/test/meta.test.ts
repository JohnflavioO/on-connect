import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createSecretBox, type SealedParts } from "@on-connect/core";
import { MetaApiError, createMetaGraph, exchangeMetaCode, type MetaGraph } from "../src/meta-graph.js";
import { parseMetaWebhook, toMetaOutgoing } from "../src/meta-mapping.js";
import { StatusesPendingError, createMetaProvider, type MetaProviderStore } from "../src/meta-provider.js";

const PHONE_ID = "106540352242922";
const NOW = new Date("2026-11-18T15:00:00Z");
const ts = (date: Date) => String(Math.floor(date.getTime() / 1000));

function webhook(value: Record<string, unknown>, phoneNumberId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
      ...value,
    } }] }],
  };
}

describe("Meta webhook mapping", () => {
  it("maps text and media like WhatsApp Web, with the contact name", () => {
    const [change] = parseMetaWebhook(webhook({
      contacts: [{ profile: { name: "Ana" }, wa_id: "5585999132494" }],
      messages: [
        { from: "5585999132494", id: "wamid.A", timestamp: ts(NOW), type: "text", text: { body: "olá" } },
        { from: "5585999132494", id: "wamid.B", timestamp: ts(NOW), type: "image",
          image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "foto" } },
        { from: "5585999132494", id: "wamid.C", timestamp: ts(NOW), type: "document",
          document: { id: "MEDIA2", mime_type: "application/pdf", filename: "nota.pdf" } },
        { from: "5585999132494", id: "wamid.D", timestamp: ts(NOW), type: "audio", audio: { id: "MEDIA3", voice: true } },
        { from: "5585999132494", id: "wamid.E", timestamp: ts(NOW), type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "yes", title: "Sim" } } },
        { from: "5585999132494", id: "wamid.F", timestamp: ts(NOW), type: "unsupported" },
      ],
    }));
    expect(change?.phoneNumberId).toBe(PHONE_ID);
    expect(change?.messages.map((m) => [m.providerId, m.content, m.mediaId])).toEqual([
      ["wamid.A", { type: "text", text: "olá" }, null],
      ["wamid.B", { type: "image", caption: "foto", mimetype: "image/jpeg" }, "MEDIA1"],
      ["wamid.C", { type: "document", mimetype: "application/pdf", fileName: "nota.pdf" }, "MEDIA2"],
      ["wamid.D", { type: "audio", voice: true }, "MEDIA3"],
      ["wamid.E", { type: "interactive", text: "Sim", replyId: "yes" }, null],
      ["wamid.F", { type: "unsupported" }, null],
    ]);
    expect(change?.messages[0]).toMatchObject({
      jid: "5585999132494@s.whatsapp.net", counterpart: "5585999132494", counterpartIsPhone: true,
      pushName: "Ana", fromMe: false, timestamp: NOW,
    });
  });

  it("maps statuses with Meta's error code on failures", () => {
    const [change] = parseMetaWebhook(webhook({ statuses: [
      { id: "wamid.X", status: "delivered", timestamp: ts(NOW), recipient_id: "5585999132494" },
      { id: "wamid.Y", status: "failed", timestamp: ts(NOW), errors: [{ code: 131047, title: "Re-engagement message" }] },
      { id: "wamid.Z", status: "deleted", timestamp: ts(NOW) },
    ] }));
    expect(change?.statuses).toEqual([
      { providerId: "wamid.X", status: "delivered", errorCode: null, timestamp: NOW },
      { providerId: "wamid.Y", status: "failed", errorCode: "meta_131047", timestamp: NOW },
    ]);
  });

  it("ignores other objects, fields and malformed parts", () => {
    expect(parseMetaWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseMetaWebhook(null)).toEqual([]);
    expect(parseMetaWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] })).toEqual([]);
    expect(parseMetaWebhook(webhook({ messages: [{ from: "not-a-number", id: "x", type: "text" }, { id: "no-from" }] }))).toEqual([]);
  });

  it("builds Meta's outbound bodies, media by link", () => {
    expect(toMetaOutgoing({ type: "text", text: "oi" })).toEqual({ type: "text", text: { body: "oi", preview_url: false } });
    expect(toMetaOutgoing({ type: "image", url: "https://x.example/a.jpg", caption: "c" }))
      .toEqual({ type: "image", image: { link: "https://x.example/a.jpg", caption: "c" } });
    expect(toMetaOutgoing({ type: "document", url: "https://x.example/n.pdf", fileName: "n.pdf" }))
      .toEqual({ type: "document", document: { link: "https://x.example/n.pdf", filename: "n.pdf" } });
    expect(toMetaOutgoing({ type: "audio", url: "https://x.example/v.ogg", voice: true }))
      .toEqual({ type: "audio", audio: { link: "https://x.example/v.ogg" } });
  });
});

describe("Graph API client", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends with the token and returns Meta's message id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { messages: [{ id: "wamid.OUT" }] }));
    const graph = createMetaGraph({ token: "token-for-tests-1234567890", version: "v23.0", fetch });
    await expect(graph.sendMessage(PHONE_ID, "5585999132494", { type: "text", text: { body: "oi", preview_url: false } }))
      .resolves.toBe("wamid.OUT");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
    expect(init?.headers).toMatchObject({ authorization: "Bearer token-for-tests-1234567890" });
    expect(JSON.parse(init?.body as string)).toMatchObject({ messaging_product: "whatsapp", to: "5585999132494", type: "text" });
  });

  it("tells permanent errors from retryable ones", async () => {
    const permanent = createMetaGraph({ token: "t".repeat(20), version: "v23.0",
      fetch: async () => json(400, { error: { code: 131047, message: "Re-engagement message" } }) });
    const error = await permanent.sendMessage(PHONE_ID, "1", { type: "text", text: { body: "x", preview_url: false } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ code: 131047, retryable: false, errorCode: "meta_131047" });

    const throttled = createMetaGraph({ token: "t".repeat(20), version: "v23.0",
      fetch: async () => json(400, { error: { code: 130429, message: "Rate limit hit" } }) });
    await expect(throttled.phoneNumber(PHONE_ID)).rejects.toMatchObject({ retryable: true });

    const down = createMetaGraph({ token: "t".repeat(20), version: "v23.0", fetch: async () => { throw new TypeError("fetch failed"); } });
    await expect(down.phoneNumber(PHONE_ID)).rejects.toMatchObject({ retryable: true, httpStatus: 0 });
  });

  it("downloads media only from Meta hosts and within the size limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(Buffer.from("12345")));
    const graph = createMetaGraph({ token: "t".repeat(20), version: "v23.0", fetch });
    await expect(graph.downloadMedia("https://evil.example/file", 100)).rejects.toThrow(/Meta host/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(graph.downloadMedia("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", 100))
      .resolves.toEqual(Buffer.from("12345"));
    await expect(graph.downloadMedia("https://lookaside.fbsbx.com/x", 3)).resolves.toBeNull();
  });
});

function fakeStore(overrides: Partial<MetaProviderStore> = {}) {
  return {
    load: vi.fn<MetaProviderStore["load"]>(async (id) => ({
      id, provider: "meta_cloud", status: "connecting", deleted: false, phoneNumberId: PHONE_ID,
    })),
    setStatus: vi.fn<MetaProviderStore["setStatus"]>(async () => undefined),
    recordInbound: vi.fn<MetaProviderStore["recordInbound"]>(async () => true),
    recordStatus: vi.fn<MetaProviderStore["recordStatus"]>(async () => true),
    metaConnectionId: vi.fn<MetaProviderStore["metaConnectionId"]>(async (id) => (id === PHONE_ID ? "conn-1" : null)),
    markMetaConnected: vi.fn<MetaProviderStore["markMetaConnected"]>(async () => undefined),
    metaCheckIds: vi.fn<MetaProviderStore["metaCheckIds"]>(async () => []),
    knowsOutbound: vi.fn<MetaProviderStore["knowsOutbound"]>(async () => true),
    loadMetaCredential: vi.fn<MetaProviderStore["loadMetaCredential"]>(async () => null),
    saveMetaCredential: vi.fn<MetaProviderStore["saveMetaCredential"]>(async () => undefined),
    ...overrides,
  };
}

function fakeGraph(overrides: Partial<MetaGraph> = {}): MetaGraph {
  return {
    phoneNumber: vi.fn(async () => ({
      displayPhoneNumber: "+55 85 99913-2494", verifiedName: "Loja", qualityRating: "GREEN", messagingLimitTier: "TIER_1K",
    })),
    sendMessage: vi.fn(async () => "wamid.OUT"),
    subscribeApp: vi.fn(async () => undefined),
    registerPhone: vi.fn(async () => undefined),
    mediaInfo: vi.fn(async () => ({ url: "https://lookaside.fbsbx.com/m", mimetype: "image/jpeg", fileSize: 5 })),
    downloadMedia: vi.fn(async () => Buffer.from("image")),
    ...overrides,
  };
}

const logger = pino({ level: "silent" });

describe("Meta provider", () => {
  it("marks a number connected with what Meta reports", async () => {
    const store = fakeStore();
    const provider = createMetaProvider({ graph: fakeGraph(), store, media: null, maxMediaBytes: 100, logger });
    await provider.check("conn-1");
    expect(store.markMetaConnected).toHaveBeenCalledWith("conn-1", expect.objectContaining({ verifiedName: "Loja", qualityRating: "GREEN" }));
  });

  it("puts the connection in error without a token, or on a permanent Meta error", async () => {
    const store = fakeStore();
    await createMetaProvider({ graph: null, store, media: null, maxMediaBytes: 100, logger }).check("conn-1");
    expect(store.setStatus).toHaveBeenLastCalledWith("conn-1", "error", "meta_not_configured");

    const graph = fakeGraph({ phoneNumber: vi.fn(async () => { throw new MetaApiError(400, 190, false, "Invalid token"); }) });
    await createMetaProvider({ graph, store, media: null, maxMediaBytes: 100, logger }).check("conn-1");
    expect(store.setStatus).toHaveBeenLastCalledWith("conn-1", "error", "meta_190");
  });

  it("keeps a connected number connected through a transient failure", async () => {
    const store = fakeStore({ load: vi.fn(async (id: string) => ({
      id, provider: "meta_cloud", status: "connected" as const, deleted: false, phoneNumberId: PHONE_ID })) });
    const graph = fakeGraph({ phoneNumber: vi.fn(async () => { throw new MetaApiError(0, null, true, "timeout"); }) });
    await createMetaProvider({ graph, store, media: null, maxMediaBytes: 100, logger }).check("conn-1");
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it("ignores WhatsApp Web connections", async () => {
    const store = fakeStore({ load: vi.fn(async (id: string) => ({
      id, provider: "whatsapp_web", status: "connected" as const, deleted: false, phoneNumberId: null })) });
    const provider = createMetaProvider({ graph: fakeGraph(), store, media: null, maxMediaBytes: 100, logger });
    await provider.check("conn-1");
    await provider.stop("conn-1");
    expect(store.markMetaConnected).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it("stores received messages with their media link, and statuses with the error code", async () => {
    const store = fakeStore();
    const save = vi.fn(async () => "https://api.example/media/abc");
    const provider = createMetaProvider({ graph: fakeGraph(), store, media: { save }, maxMediaBytes: 100, logger, now: () => NOW });
    await provider.handleWebhook(webhook({
      messages: [{ from: "5585999132494", id: "wamid.IMG", timestamp: ts(NOW), type: "image", image: { id: "M", mime_type: "image/jpeg" } }],
      statuses: [{ id: "wamid.OUT", status: "failed", timestamp: ts(NOW), errors: [{ code: 131047 }] }],
    }));
    expect(save).toHaveBeenCalledWith(Buffer.from("image"), { mimetype: "image/jpeg" });
    expect(store.recordInbound).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      providerId: "wamid.IMG", mediaUrl: "https://api.example/media/abc" }));
    expect(store.recordStatus).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      providerId: "wamid.OUT", status: "failed", errorCode: "meta_131047" }));
  });

  it("keeps a message whose media could not be fetched, and skips files over the limit", async () => {
    const recordInbound = vi.fn<MetaProviderStore["recordInbound"]>(async () => true);
    const store = fakeStore({ recordInbound });
    const graph = fakeGraph({ mediaInfo: vi.fn(async () => { throw new MetaApiError(404, 100, false, "gone"); }) });
    const provider = createMetaProvider({ graph, store, media: { save: vi.fn() }, maxMediaBytes: 100, logger, now: () => NOW });
    const body = webhook({ messages: [{ from: "5585999132494", id: "wamid.IMG", timestamp: ts(NOW), type: "image", image: { id: "M" } }] });
    await provider.handleWebhook(body);
    expect(recordInbound.mock.calls[0]?.[1].mediaUrl).toBeUndefined();

    const downloadMedia = vi.fn(async () => Buffer.from("x"));
    const big = fakeGraph({ downloadMedia,
      mediaInfo: vi.fn(async () => ({ url: "https://lookaside.fbsbx.com/m", mimetype: null, fileSize: 1_000 })) });
    await createMetaProvider({ graph: big, store, media: { save: vi.fn() }, maxMediaBytes: 100, logger, now: () => NOW }).handleWebhook(body);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it("retries recent statuses of messages not stored yet, not old or unknown numbers", async () => {
    const store = fakeStore({ knowsOutbound: vi.fn(async () => false) });
    const provider = createMetaProvider({ graph: fakeGraph(), store, media: null, maxMediaBytes: 100, logger, now: () => NOW });
    await expect(provider.handleWebhook(webhook({ statuses: [{ id: "wamid.NEW", status: "sent", timestamp: ts(NOW) }] })))
      .rejects.toBeInstanceOf(StatusesPendingError);
    const old = new Date(NOW.getTime() - 10 * 60_000);
    await expect(provider.handleWebhook(webhook({ statuses: [{ id: "wamid.OLD", status: "sent", timestamp: ts(old) }] })))
      .resolves.toBeUndefined();
    await expect(provider.handleWebhook(webhook({ statuses: [{ id: "wamid.NEW", status: "sent", timestamp: ts(NOW) }] }, "999")))
      .resolves.toBeUndefined();
  });

  it("sends through the Graph API with Meta's body", async () => {
    const sendMessage = vi.fn(async () => "wamid.OUT");
    const provider = createMetaProvider({ graph: fakeGraph({ sendMessage }), store: fakeStore(), media: null, maxMediaBytes: 100, logger });
    await expect(provider.sender?.send("conn-1", PHONE_ID, "5585999132494", { type: "text", text: "oi" })).resolves.toBe("wamid.OUT");
    expect(sendMessage).toHaveBeenCalledWith(PHONE_ID, "5585999132494", { type: "text", text: { body: "oi", preview_url: false } });
    expect(createMetaProvider({ graph: null, store: fakeStore(), media: null, maxMediaBytes: 100, logger }).sender).toBeNull();
  });
});

describe("Meta Embedded Signup", () => {
  const box = createSecretBox(Buffer.alloc(32, 9).toString("base64"));
  const WABA = "200000000000001";
  const metaRow = (id: string) => ({
    id, provider: "meta_cloud", status: "connecting" as const, deleted: false, phoneNumberId: PHONE_ID, wabaId: WABA,
  });

  it("swaps the code, stores the customer's token encrypted, links the account and registers the number", async () => {
    let saved: SealedParts | null = null;
    const store = fakeStore({
      load: vi.fn(async (id: string) => metaRow(id)),
      saveMetaCredential: vi.fn(async (_id: string, sealed: SealedParts) => { saved = sealed; }),
    });
    const subscribeApp = vi.fn(async () => undefined);
    const registerPhone = vi.fn(async () => undefined);
    const customer = fakeGraph({ subscribeApp, registerPhone });
    const tokens: string[] = [];
    const exchangeCode = vi.fn(async () => "EAAcustomer-business-token-1234567890");
    const provider = createMetaProvider({
      graph: null, box, exchangeCode, store, media: null, maxMediaBytes: 100, logger,
      graphForToken: (token) => { tokens.push(token); return customer; },
      newPin: () => "482913",
    });

    await expect(provider.signup("conn-1", "AQB-signup-code")).resolves.toEqual({ ok: true });
    expect(exchangeCode).toHaveBeenCalledWith("AQB-signup-code");
    expect(tokens).toEqual(["EAAcustomer-business-token-1234567890"]);
    expect(subscribeApp).toHaveBeenCalledWith(WABA);
    expect(registerPhone).toHaveBeenCalledWith(PHONE_ID, "482913");
    expect(store.markMetaConnected).toHaveBeenCalledWith("conn-1", expect.objectContaining({ verifiedName: "Loja" }));
    // Encrypted, bound to this connection: not readable as text, not usable for another one.
    expect(saved).not.toBeNull();
    const stored = saved as unknown as SealedParts;
    expect(stored.ciphertext.toString("utf8")).not.toContain("EAAcustomer");
    expect(JSON.parse(box.openParts(stored, "meta_credential:conn-1"))).toEqual({
      token: "EAAcustomer-business-token-1234567890", pin: "482913" });
    expect(() => box.openParts(stored, "meta_credential:conn-2")).toThrow();
  });

  it("sends with the customer's token once the connection has one, and the server's otherwise", async () => {
    const sealed = box.sealParts(JSON.stringify({ token: "EAAcustomer-token-abcdefghij", pin: "1" }), "meta_credential:own");
    const store = fakeStore({ loadMetaCredential: vi.fn(async (id: string) => (id === "own" ? sealed : null)) });
    const serverSend = vi.fn(async () => "wamid.SERVER");
    const customerSend = vi.fn(async () => "wamid.CUSTOMER");
    const provider = createMetaProvider({
      graph: fakeGraph({ sendMessage: serverSend }), box, store, media: null, maxMediaBytes: 100, logger,
      graphForToken: () => fakeGraph({ sendMessage: customerSend }),
    });
    await expect(provider.sender?.send("own", PHONE_ID, "5585999132494", { type: "text", text: "oi" })).resolves.toBe("wamid.CUSTOMER");
    await expect(provider.sender?.send("shared", PHONE_ID, "5585999132494", { type: "text", text: "oi" })).resolves.toBe("wamid.SERVER");
  });

  it("records Meta's error as the connection status when onboarding fails", async () => {
    const store = fakeStore({ load: vi.fn(async (id: string) => metaRow(id)) });
    const provider = createMetaProvider({
      graph: null, box, store, media: null, maxMediaBytes: 100, logger,
      exchangeCode: vi.fn(async () => { throw new MetaApiError(400, 100, false, "Invalid verification code format"); }),
      graphForToken: () => fakeGraph(),
    });
    await expect(provider.signup("conn-1", "expired-code")).resolves.toEqual({ ok: false, error: "meta_100" });
    expect(store.setStatus).toHaveBeenCalledWith("conn-1", "error", "meta_100");
    expect(store.saveMetaCredential).not.toHaveBeenCalled();
  });

  it("refuses when Embedded Signup is not configured or the connection is not a Meta one", async () => {
    const store = fakeStore();
    await expect(createMetaProvider({ graph: fakeGraph(), store, media: null, maxMediaBytes: 100, logger })
      .signup("conn-1", "code")).resolves.toEqual({ ok: false, error: "meta_signup_not_configured" });
    const web = fakeStore({ load: vi.fn(async (id: string) => ({ ...metaRow(id), provider: "whatsapp_web" })) });
    await expect(createMetaProvider({
      graph: null, box, store: web, media: null, maxMediaBytes: 100, logger,
      exchangeCode: vi.fn(async () => "x".repeat(30)), graphForToken: () => fakeGraph(),
    }).signup("conn-1", "code")).resolves.toEqual({ ok: false, error: "connection_not_found" });
  });
});

describe("Meta code exchange", () => {
  it("asks Meta for the business token with the app id and secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ access_token: "EAAbusiness-token-1234567890", token_type: "bearer" }), { status: 200 }));
    await expect(exchangeMetaCode({ appId: "1473739174705593", appSecret: "app-secret-for-tests", code: "AQBcode",
      version: "v27.0", fetch })).resolves.toBe("EAAbusiness-token-1234567890");
    const url = fetch.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/v27.0/oauth/access_token");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1473739174705593", client_secret: "app-secret-for-tests", code: "AQBcode" });
  });

  it("fails with Meta's code when the code is expired or reused", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ error: { code: 100, message: "This authorization code has expired." } }), { status: 400 }));
    await expect(exchangeMetaCode({ appId: "1", appSecret: "s".repeat(16), code: "old", version: "v27.0", fetch }))
      .rejects.toMatchObject({ errorCode: "meta_100", retryable: false });
  });
});
