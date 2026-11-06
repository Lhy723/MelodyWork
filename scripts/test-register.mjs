import { register } from "node:module";

/**
 * Register the renderer `@/` alias resolver for `node --test`.
 * Loaded through `--import ./scripts/test-register.mjs` in `test:unit`.
 */
register("./test-alias-hooks.mjs", import.meta.url);
