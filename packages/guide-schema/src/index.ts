/**
 * @circa/guide-schema — the contract shared by the Admin Portal, the legacy importer
 * and the Chrome extension.
 *
 * Everything that used to be duplicated between `shared.js` and `content.js` in the
 * v2.4.9 extension lives here exactly once:
 *   - normalizeAction   (was shared.js:21 AND content.js:768 `getAction`)
 *   - inferUrlMatchMode (was shared.js:35 AND content.js:271 `inferModeFromPattern`)
 *   - the URL matcher   (was urlMatches content.js:147 AND stepUrlMatches content.js:289)
 */

export * from "./types.ts";
export * from "./constants.ts";
export * from "./text.ts";
export * from "./url-match.ts";
export * from "./normalize.ts";
export * from "./checksum.ts";
export * from "./flags.ts";
export * from "./validate.ts";
