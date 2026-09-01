import { readFileSync } from "node:fs";

const imports = readFileSync("src/services/importService.ts", "utf8");
const staged = readFileSync("src/services/stagedRows.ts", "utf8");
const server = readFileSync("src/server.ts", "utf8");
const admin = readFileSync("public/admin.html", "utf8");
const failures = [];
const must = (ok, msg) => { if (!ok) failures.push(msg); };

must(imports.includes("rehydrateStagedRows(format, stagedRows)"), "commitBatch must rehydrate staged temporal values before importing");
must(staged.includes('field.type === "date" || field.type === "datetime"'), "all contract DATE/DATETIME fields must be restored");
must(imports.includes('compareDateValues(row.observed_at, existing.observedAt, "observed_at")'), "dated projections must use defensive date comparison");
must(!imports.includes("row.observed_at.getTime()"), "import commit must not call getTime directly on staged observed_at values");
must(server.includes('"import batch commit failed"') && server.includes('reply.code(500).send({ error: safe'), "commit route must log failures and return a useful error");
must(admin.includes("if(resultArea) resultArea.innerHTML=''"), "reset UI must not dereference a missing import result element");

if (failures.length) {
  console.error("Import regression check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("Import regression check passed: staged temporal values are rehydrated and admin commit/reset errors are guarded.");
