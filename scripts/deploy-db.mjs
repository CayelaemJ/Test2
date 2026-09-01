import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const prisma = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
const resetRequested = ["1", "true", "yes"].includes(String(process.env.PRELIVE_RESET_DATABASE ?? "").toLowerCase());

function run(args) {
  const result = spawnSync(prisma, args, { stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

console.log("Validating Prisma schema...");
if (run(["validate"]) !== 0) process.exit(1);

if (resetRequested) {
  if (process.env.PRELIVE_RESET_CONFIRM !== "DELETE_PRELIVE_DATA") {
    console.error("PRELIVE_RESET_DATABASE is enabled. Set PRELIVE_RESET_CONFIRM=DELETE_PRELIVE_DATA to confirm the one-time reset.");
    process.exit(1);
  }
  console.warn("PRE-LIVE RESET CONFIRMED: rebuilding the application database schema and deleting existing application data.");
  process.exit(run(["db", "push", "--force-reset", "--skip-generate"]));
}

console.log("Applying non-destructive Prisma schema sync...");
const status = run(["db", "push", "--skip-generate"]);
if (status !== 0) {
  console.error("Database schema sync failed. Because destructive fallback is disabled, no reset was attempted.");
  console.error("For a disposable pre-live database only, set PRELIVE_RESET_DATABASE=true and PRELIVE_RESET_CONFIRM=DELETE_PRELIVE_DATA for one deployment, then remove both variables.");
}
process.exit(status);
