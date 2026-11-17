import type { SessionGateway } from "@on-connect/core";

/** Records commands instead of talking to Redis and the sessions process. */
export class FakeSessions implements SessionGateway {
  readonly started: string[] = [];
  readonly loggedOut: string[] = [];
  readonly pairingRequests: Array<[string, string]> = [];
  qr = new Map<string, string>();
  pairingCode: string | null = "ABCD-1234";

  async start(connectionId: string) {
    this.started.push(connectionId);
  }
  async logout(connectionId: string) {
    this.loggedOut.push(connectionId);
  }
  async currentQr(connectionId: string) {
    return this.qr.get(connectionId) ?? null;
  }
  async requestPairingCode(connectionId: string, phoneNumber: string) {
    this.pairingRequests.push([connectionId, phoneNumber]);
    return this.pairingCode;
  }
}
