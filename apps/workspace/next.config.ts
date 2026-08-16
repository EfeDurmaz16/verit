import type { NextConfig } from "next";

/* The verit packages ship TypeScript source (exports point at ./src/index.ts)
   and use NodeNext-style ".js" specifiers, so Next has to compile them itself. */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@verit/domain",
    "@verit/ports",
    "@verit/application",
    "@verit/adapter-memory",
    "@verit/adapter-sqlite",
    "@verit/proof-ui",
  ],
};

export default nextConfig;
