import { describe, expect, it } from "vitest";
import {
  assertDomainFocus,
  decodeUnderstanding,
  ReviewDomain,
  Understanding,
} from "./index";
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

  it("accepts a risk with a file, line and severity", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      proof_refs: [],
      risks: [
        { area: "auth", note: "unguarded", source: "reviewer", file: "src/a.ts", line: 42, severity: "high" },
      ],
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    const r = decoded.right.risks[0];
    expect(r?.file).toBe("src/a.ts");
    expect(r?.line).toBe(42);
    expect(r?.severity).toBe("high");
  });

  it("decodes an older risk with no location, unchanged: backward compatible", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      proof_refs: [],
      // no file, line or severity: what every stored run before this change holds
      risks: [{ area: "x", note: "n", source: "author" }],
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    const r = decoded.right.risks[0];
    expect(r?.file).toBeUndefined();
    expect(r?.severity).toBeUndefined();
  });

  it("rejects an unknown severity", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      proof_refs: [],
      risks: [{ area: "x", note: "n", source: "reviewer", severity: "critical" }],
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("accepts a url proof ref that is an absolute URL", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      proof_refs: [{ kind: "url", label: "docs", value: "https://example.com/x" }],
      risks: [],
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("rejects a url proof ref that is a relative path", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      // a bare path is not openable as a link: it must fail decode
      proof_refs: [{ kind: "url", label: "first-path", value: "README.md" }],
      risks: [],
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("leaves a non-url ref with a relative value alone", () => {
    const decoded = decodeUnderstanding({
      what: "w",
      why: "y",
      how: "h",
      // only kind:url is constrained; a command ref keeps any string
      proof_refs: [{ kind: "command", label: "run", value: "pnpm test" }],
      risks: [],
    });
    expect(Either.isRight(decoded)).toBe(true);
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
