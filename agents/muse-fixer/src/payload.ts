// The payload format is Intenzo's (ARCHITECTURE §26.3) and lives in core. install.ts copies core's
// file over this one in the target repo, where @intenzo/core isn't installed.
export * from "../../../packages/core/src/fixer/payload.ts";
