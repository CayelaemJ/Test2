import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { detectFormat, parseFile, validate } from "../src/services/importParser.js";
import { REPORT_FORMATS } from "../src/services/reportFormats.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const samples = path.join(root, "sample-imports");

const expectedReports = [
  "employers",
  "workforce_snapshots",
  "employees",
  "platform_users",
  "journeys",
  "debt_accounts",
  "policies",
  "ratings",
  "referrals",
  "salary_advances",
];

const expectedDateFields: Record<string, string[]> = {
  employers: ["eligible_count_as_at", "source_updated_at"],
  workforce_snapshots: ["as_of_date", "source_updated_at"],
  employees: ["observed_at", "eligible_from", "source_updated_at"],
  platform_users: ["enrolled_at", "source_updated_at"],
  journeys: ["started_at", "source_updated_at"],
  debt_accounts: ["observed_at", "source_updated_at"],
  policies: ["observed_at", "source_updated_at"],
  ratings: ["created_at", "source_updated_at"],
  referrals: ["shared_at", "source_updated_at"],
  salary_advances: ["advanced_at", "source_updated_at"],
};

const failures: string[] = [];
const formatsByKey = new Map(REPORT_FORMATS.map((format) => [format.key, format]));

if (REPORT_FORMATS.length !== expectedReports.length) {
  failures.push(`Expected ${expectedReports.length} report formats, found ${REPORT_FORMATS.length}.`);
}

for (const [index, key] of expectedReports.entries()) {
  const format = formatsByKey.get(key);
  if (!format) {
    failures.push(`Missing report format: ${key}.`);
    continue;
  }
  if (REPORT_FORMATS[index]?.key !== key) {
    failures.push(`Load-order mismatch at position ${index + 1}: expected ${key}, found ${REPORT_FORMATS[index]?.key ?? "nothing"}.`);
  }

  const fields = new Map(format.fields.map((field) => [field.name, field]));
  for (const name of ["source_updated_at", "is_deleted"]) {
    if (!fields.has(name)) failures.push(`${key}: missing common technical field ${name}.`);
  }
  if (fields.get("source_updated_at")?.type !== "datetime" || fields.get("source_updated_at")?.required !== true) {
    failures.push(`${key}: source_updated_at must be a required datetime.`);
  }
  for (const name of expectedDateFields[key]) {
    if (!fields.has(name)) failures.push(`${key}: missing business/filter date field ${name}.`);
  }
  for (const naturalKeyPart of format.naturalKey) {
    if (!fields.has(naturalKeyPart)) failures.push(`${key}: natural-key field ${naturalKeyPart} is not defined.`);
  }

  const filename = `${key}.csv`;
  const filePath = path.join(samples, filename);
  if (!fs.existsSync(filePath)) {
    failures.push(`${key}: missing sample file ${filename}.`);
    continue;
  }
  const parsed = parseFile(fs.readFileSync(filePath), detectFormat(filename));
  const result = validate(format, parsed);
  if (!result.ok) {
    const details = [
      ...result.missingColumns.map((column) => `missing column ${column}`),
      ...result.errors.slice(0, 8).map((error) => `row ${error.row}, ${error.column}: ${error.reason}`),
    ].join("; ");
    failures.push(`${key}: sample validation failed: ${details}`);
  }
}

const duplicateKeys = REPORT_FORMATS.map((format) => format.key).filter((key, index, all) => all.indexOf(key) !== index);
if (duplicateKeys.length) failures.push(`Duplicate report keys: ${duplicateKeys.join(", ")}.`);

if (failures.length) {
  console.error("empower-fin source contract check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`empower-fin source contract check passed: ${REPORT_FORMATS.length} reports and ${REPORT_FORMATS.length} sample feeds validated.`);
