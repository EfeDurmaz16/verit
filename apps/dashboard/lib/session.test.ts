import { beforeEach, describe, expect, it } from "vitest";
import { parseSession, sealSession, type Session } from "./session";

const now = 1_800_000_000;
const session: Session = { login: "efe", userId: 7, ghToken: "gho_x", exp: now + 60 };

beforeEach(() => {
  process.env.CYCLOPS_SESSION_SECRET = "x".repeat(48);
});

describe("session cookie", () => {
  it("round-trips a sealed session", () => {
    expect(parseSession(sealSession(session), now)).toEqual(session);
  });

  it("rejects a cookie sealed with a different secret", () => {
    const sealed = sealSession(session);
    process.env.CYCLOPS_SESSION_SECRET = "y".repeat(48);
    expect(parseSession(sealed, now)).toBeNull();
  });

  it("rejects a tampered cookie", () => {
    const sealed = sealSession(session);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}=`.slice(0, sealed.length);
    expect(parseSession(flipped, now)).toBeNull();
  });

  it("rejects an expired session", () => {
    expect(parseSession(sealSession(session), session.exp + 1)).toBeNull();
  });

  it("rejects a missing cookie", () => {
    expect(parseSession(undefined, now)).toBeNull();
  });
});
