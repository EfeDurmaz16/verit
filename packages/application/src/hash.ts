/** Pure deterministic hex digest (no Node crypto — application stays platform-free). */
export const contentHash = (body: string, length = 32): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  let out = "";
  while (out.length < length) {
    out += hex(h1) + hex(h2);
    h1 = Math.imul(h1 ^ h2, 0x85ebca6b);
    h2 = Math.imul(h2 ^ h1, 0xc2b2ae35);
  }
  return out.slice(0, length);
};
