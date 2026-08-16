import type { NextConfig } from "next";

/* The verit packages ship TypeScript source (exports point at ./src), so
   Next has to compile them itself. */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@verit/domain",
    "@verit/ports",
    "@verit/adapter-local-blob",
    "@verit/proof-ui",
  ],
};

export default nextConfig;
