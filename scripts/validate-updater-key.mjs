import { readFileSync } from "node:fs";

const config = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const configuredKey = config.plugins?.updater?.pubkey;

const fail = (message) => {
  console.error(`Invalid Tauri updater public key: ${message}`);
  process.exit(1);
};

if (typeof configuredKey !== "string" || configuredKey.length === 0) {
  fail("plugins.updater.pubkey is empty");
}
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(configuredKey)) {
  fail("plugins.updater.pubkey must be a single Base64 value");
}

const decoded = Buffer.from(configuredKey, "base64").toString("utf8");
if (Buffer.from(decoded, "utf8").toString("base64") !== configuredKey) {
  fail("plugins.updater.pubkey is not canonical Base64");
}

const lines = decoded.trimEnd().split("\n");
if (
  lines.length !== 2 ||
  !/^untrusted comment: minisign public key: [0-9A-F]{16}$/.test(lines[0]) ||
  !/^RW[A-Za-z0-9+/]+={0,2}$/.test(lines[1])
) {
  fail("decoded value is not a two-line minisign public key");
}

const actionKey = process.env.TAURI_UPDATER_PUBLIC_KEY;
if (actionKey !== undefined && actionKey !== configuredKey) {
  fail("GitHub Actions variable does not match tauri.conf.json");
}

console.log(`Updater public key is valid (${lines[0].slice(-16)}).`);
