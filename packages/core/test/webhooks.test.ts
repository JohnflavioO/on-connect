import { describe, expect, it } from "vitest";
import {
  checkWebhookUrl,
  generateWebhookSecret,
  isPublicAddress,
  signWebhook,
  verifyWebhookSignature,
} from "../src/webhooks.js";

describe("webhook signatures", () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: "evt", type: "message.received" });

  it("generates distinct, prefixed secrets", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(secret);
  });

  it("verifies its own signature within the tolerance", () => {
    const header = signWebhook(secret, 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1_700_000_100 })).toBe(true);
  });

  it("rejects another body, another secret, a stale timestamp and garbage", () => {
    const header = signWebhook(secret, 1_700_000_000, body);
    const now = { nowSeconds: 1_700_000_000 };
    expect(verifyWebhookSignature(secret, header, `${body} `, now)).toBe(false);
    expect(verifyWebhookSignature(generateWebhookSecret(), header, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1_700_000_301 })).toBe(false);
    expect(verifyWebhookSignature(secret, "v1=abc", body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, "t=1700000000,v1=zz", body, now)).toBe(false);
  });

  it("binds the timestamp into the signature", () => {
    const header = signWebhook(secret, 1_700_000_000, body).replace("t=1700000000", "t=1700000001");
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1_700_000_001 })).toBe(false);
  });
});

describe("webhook destinations", () => {
  it.each([
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.20.0.5", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:7f00:1", false],
    ["not-an-ip", false],
  ])("isPublicAddress(%s) = %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it.each([
    ["https://tendi.example.com/hooks/onconnect?token=abc", null],
    ["https://8.8.8.8/hook", null],
    ["http://tendi.example.com/hook", "https_required"],
    ["https://user:pw@tendi.example.com/hook", "credentials_not_allowed"],
    ["https://localhost/hook", "private_address"],
    ["https://redis/hook", "private_address"],
    ["https://api.internal/hook", "private_address"],
    ["https://127.0.0.1/hook", "private_address"],
    ["https://0x7f.1/hook", "private_address"],
    ["https://[::1]/hook", "private_address"],
    ["https://169.254.169.254/latest", "private_address"],
    ["not a url", "invalid_url"],
    [`https://tendi.example.com/${"a".repeat(2048)}`, "too_long"],
  ])("checkWebhookUrl(%s) = %s", (url, expected) => {
    expect(checkWebhookUrl(url)).toBe(expected);
  });
});
