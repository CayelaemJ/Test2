// ════════════════════════════════════════════════════════════════════
//  TEMPLATE GENERATOR
//  Produces a downloadable starter file for any report, so admins always
//  upload the right shape. CSV = header + one example row. XLSX = a data
//  sheet (header + example) plus a "Field Guide" sheet documenting every
//  column (type, required, allowed values, description).
// ════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx";
import { ReportFormat } from "./reportFormats.js";

export function csvTemplate(format: ReportFormat): string {
  const header = format.fields.map((f) => f.name).join(",");
  const example = format.fields
    .map((f) => {
      const value = f.example ?? "";
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(",");
  return `${header}\n${example}\n`;
}

export function xlsxTemplate(format: ReportFormat): Buffer {
  const wb = XLSX.utils.book_new();

  // Sheet 1 — data: header row + one example row
  const header = format.fields.map((f) => f.name);
  const example = format.fields.map((f) => f.example);
  const dataSheet = XLSX.utils.aoa_to_sheet([header, example]);
  XLSX.utils.book_append_sheet(wb, dataSheet, "Data");

  // Sheet 2 — field guide
  const guideRows = [
    ["Column", "Type", "Required", "Allowed values", "Description"],
    ...format.fields.map((f) => [
      f.name,
      f.type,
      f.required ? "yes" : "no",
      f.enumValues ? f.enumValues.join(" | ") : f.cents ? "rands (e.g. 298.00)" : "",
      f.description,
    ]),
  ];
  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);
  guideSheet["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 9 }, { wch: 40 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, guideSheet, "Field Guide");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** A machine-readable spec of all reports — handy for the admin UI to render. */
export function formatManifest(formats: ReportFormat[]) {
  return formats.map((f) => ({
    key: f.key,
    title: f.title,
    description: f.description,
    naturalKey: f.naturalKey,
    fields: f.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      allowed: field.enumValues ?? null,
      unit: field.cents ? "rand" : null,
      description: field.description,
    })),
  }));
}
