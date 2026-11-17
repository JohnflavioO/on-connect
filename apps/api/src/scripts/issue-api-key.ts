/**
 * Issues an API key for an existing client.
 *
 *   API_KEY_PEPPER=... pnpm --filter @on-connect/api issue-key -- <client-uuid> <label> [expires-at-iso]
 *
 * Prints the key once and the INSERT an operator runs with admin rights
 * (Supabase SQL Editor as postgres, which bypasses RLS, or as onconnect_system).
 * The script never connects to the database, so it needs no system credentials,
 * and the key itself is never stored anywhere.
 */
import { generateApiKey } from "@on-connect/core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [clientId, label, expiresAt] = process.argv.slice(2).filter((arg) => arg !== "--");
const pepper = process.env.API_KEY_PEPPER;

if (!pepper) fail("API_KEY_PEPPER is not set");
if (!clientId || !UUID_PATTERN.test(clientId)) fail("First argument must be the client uuid");
if (!label || label.length > 100) fail("Second argument must be a label (max 100 characters)");
if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
  fail("Third argument, when given, must be an ISO 8601 timestamp");
}

const issued = generateApiKey(pepper);
const expiry = expiresAt === undefined ? "null" : sqlLiteral(new Date(expiresAt).toISOString());

console.log(`API key (shown once, deliver it over a secure channel):\n\n  ${issued.key}\n`);
console.log("Run in the Supabase SQL Editor (postgres) or as onconnect_system:\n");
console.log(
  `insert into onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash, expires_at)\n` +
    `  values (${sqlLiteral(clientId)}, ${sqlLiteral(label)}, ${sqlLiteral(issued.prefix)}, ` +
    `${sqlLiteral(issued.secretHash)}, ${expiry});`,
);
