import type { NextConfig } from "next";

/* The cyclops packages ship TypeScript source (exports point at ./src/index.ts)
   and use NodeNext-style ".js" specifiers, so Next has to compile them itself. */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@cyclops/domain",
    "@cyclops/ports",
    "@cyclops/application",
    "@cyclops/adapter-memory",
    "@cyclops/adapter-sqlite",
  ],
};

export default nextConfig;
