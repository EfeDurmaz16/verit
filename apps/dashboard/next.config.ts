import type { NextConfig } from "next";

/* The cyclops packages ship TypeScript source (exports point at ./src), so
   Next has to compile them itself. */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@cyclops/domain",
    "@cyclops/ports",
    "@cyclops/adapter-local-blob",
    "@cyclops/proof-ui",
  ],
};

export default nextConfig;
