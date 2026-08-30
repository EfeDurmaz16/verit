export * from "./check";
export * from "./chunks";
// The Check's annotation resolver lives in @verit/netdiff; re-export the one
// helper the CLI needs so it stays on the application's public surface.
export { changedHeadLines } from "@verit/netdiff";
export * from "./compiler";
export * from "./prove";
export * from "./redact";
export * from "./context";
export * from "./edges";
export * from "./hash";
export * from "./proof-spec";
export * from "./ingest-wiki";
export * from "./run-review";
export * from "./evidence-check";
export * from "./probe-select";
