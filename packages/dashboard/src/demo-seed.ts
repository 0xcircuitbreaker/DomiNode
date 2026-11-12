/**
 * Local demo seed (docker-compose.demo.yml only). Creates one pre-funded,
 * wallet-identity demo principal with a dn_live_ API key, and writes the
 * throwaway credentials to DEMO_DIR so the demo node container can register.
 *
 * Refuses to run unless DEMO_MODE=1 AND NODE_ENV=development. Idempotent:
 * if DEMO_DIR/api-key already exists and its key is still valid, nothing changes.
 *
 *   node packages/dashboard/dist/src/demo-seed.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Wallet } from "ethers";
import { connectWithRetry, closePool, query, userRepo, walletRepo, generateApiKey, hashApiKey } from "@dominusnode/shared";

export const DEMO_CREDIT_CENTS = 1_000; // $10 of demo credit

export function assertDemoEnv(env: NodeJS.ProcessEnv): void {
  if (env["DEMO_MODE"] !== "1" || env["NODE_ENV"] !== "development") {
    throw new Error("demo-seed refuses to run: requires DEMO_MODE=1 and NODE_ENV=development");
  }
}

export const DEMO_BANNER = [
  "",
  "==================================================================",
  "  DEMO, NOT FOR PRODUCTION. Throwaway keys, fake credit, local only.",
  "==================================================================",
  "",
].join("\n");

function writeSecret(file: string, value: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

async function existingKeyValid(keyFile: string): Promise<boolean> {
  if (!fs.existsSync(keyFile)) return false;
  const raw = fs.readFileSync(keyFile, "utf8").trim();
  if (!/^dn_live_[0-9a-f]{16,128}$/.test(raw)) return false;
  const r = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(raw)],
  );
  return r.rows.length > 0;
}

export async function seedDemo(dir: string): Promise<{ created: boolean }> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "api-key");
  const walletFile = path.join(dir, "wallet.key");
  if (await existingKeyValid(keyFile)) return { created: false };

  const wallet = Wallet.createRandom();
  const addr = wallet.address.toLowerCase();
  const user = await userRepo.createWalletUser(
    addr,
    `${addr}@wallet.demo.invalid`,
    crypto.randomBytes(32).toString("hex"),
  );
  await walletRepo.createWallet(user.id);
  await walletRepo.creditWallet(user.id, DEMO_CREDIT_CENTS, "demo", `demo-${user.id}`, "Local demo credit (not real money)");
  const key = generateApiKey();
  await userRepo.createApiKey(user.id, key.hash, key.prefix, "demo");

  for (const f of [keyFile, walletFile]) fs.rmSync(f, { force: true });
  writeSecret(walletFile, wallet.privateKey);
  writeSecret(keyFile, key.raw);
  return { created: true };
}

async function main(): Promise<number> {
  assertDemoEnv(process.env);
  process.stderr.write(DEMO_BANNER);
  await connectWithRetry();
  try {
    const dir = process.env["DEMO_DIR"] || "/demo";
    const r = await seedDemo(dir);
    process.stderr.write(r.created ? `demo principal created; API key in ${dir}/api-key\n` : "demo principal already seeded\n");
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && /demo-seed\.js$/.test(process.argv[1])) {
  main().then((c) => process.exit(c), (err: unknown) => {
    process.stderr.write(`demo-seed failed: ${err instanceof Error ? err.message : "error"}\n`);
    process.exit(1);
  });
}
