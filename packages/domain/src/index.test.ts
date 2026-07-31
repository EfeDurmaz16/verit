import { describe, expect, it } from "vitest";
import {
  assertDomainFocus,
  decodeUnderstanding,
  ReviewDomain,
  Understanding,
} from "./index.js";
import { Schema as S, Either } from "effect";

describe("Understanding", () => {
  it("accepts canonical shape", () => {
    const raw = {
      what: "Add pay gate CLI commands",
      why: "Operators need gated pay flows",
      how: "New subcommands under cli pay gate",
      proof_refs: [{ kind: "command", label: "unit", value: "pnpm test" }],
      out_of_scope: ["mobile SDK"],
      risks: [{ area: "auth", note: "token scoping", source: "author" }],
    };
    const decoded = decodeUnderstanding(raw);
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("rejects empty what", () => {
    const decoded = decodeUnderstanding({
      what: "",
      why: "x",
      how: "y",
      proof_refs: [],
      risks: [],
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("ReviewDomain / focus", () => {
  it("parses CRYPTO", () => {
    const r = S.decodeUnknownEither(ReviewDomain)("CRYPTO");
    expect(Either.isRight(r)).toBe(true);
  });

  it("forbids focus === domain", () => {
    expect(() => assertDomainFocus("SECURITY", "SECURITY")).toThrow();
    expect(() => assertDomainFocus("SECURITY", "PERFORMANCE")).not.toThrow();
  });
});

describe("Understanding encode roundtrip", () => {
  it("roundtrips", () => {
    const u: Understanding = {
      what: "w",
      why: "y",
      how: "h",
      proof_refs: [],
      risks: [],
    };
    const enc = S.encodeUnknownSync(Understanding)(u);
    const dec = S.decodeUnknownSync(Understanding)(enc);
    expect(dec).toEqual(u);
  });
});
