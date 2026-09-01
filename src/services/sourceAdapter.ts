// ════════════════════════════════════════════════════════════════════
//  EXTERNAL SOURCE ADAPTERS
//
//  The empower-fin Dashboard Portal can ingest the canonical 10 core feeds from either:
//    • HTTP API endpoints (bearer-token JSON), or
//    • read-only SQL views in PostgreSQL, Microsoft SQL Server or MySQL.
//
//  Both modes return the same canonical rows to syncService, which means SQL
//  can never bypass validation, natural-key upserts, dated history or dashboard
//  calculations.
// ════════════════════════════════════════════════════════════════════

import { LOAD_ORDER, getFormat } from "./reportFormats.js";

export type SourceMode = "API" | "SQL";
export type SqlDialect = "POSTGRESQL" | "MSSQL" | "MYSQL";

export interface SourceWindow {
  since?: Date | null;
  through?: Date;
}

export interface SourceFetchResult {
  records: Record<string, unknown>[];
  location: string;
}

export interface IntegrationSourceConfig {
  sourceMode?: string | null;
  baseUrl?: string | null;
  authToken?: string | null;
  sqlDialect?: string | null;
  sqlHost?: string | null;
  sqlPort?: number | null;
  sqlDatabase?: string | null;
  sqlSchema?: string | null;
  sqlUsername?: string | null;
  sqlPassword?: string | null;
  sqlSsl?: boolean | null;
  sqlTrustServerCertificate?: boolean | null;
  sqlViewPrefix?: string | null;
  sqlQueryTimeoutMs?: number | null;
  sqlMaxRowsPerReport?: number | null;
}

export interface SourceAdapter {
  mode: SourceMode;
  label: string;
  fetchReport(reportKey: string, window?: SourceWindow): Promise<SourceFetchResult>;
  test(): Promise<{ ok: true; note: string; details?: unknown }>;
  close(): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function intSetting(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function boolEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function withEnvironment(config: IntegrationSourceConfig): IntegrationSourceConfig {
  return {
    ...config,
    baseUrl: process.env.SOURCE_API_BASE_URL || config.baseUrl,
    authToken: process.env.SOURCE_API_TOKEN || config.authToken,
    sqlDialect: process.env.SOURCE_SQL_DIALECT || config.sqlDialect,
    sqlHost: process.env.SOURCE_SQL_HOST || config.sqlHost,
    sqlPort: numberEnv("SOURCE_SQL_PORT") ?? config.sqlPort,
    sqlDatabase: process.env.SOURCE_SQL_DATABASE || config.sqlDatabase,
    sqlSchema: process.env.SOURCE_SQL_SCHEMA ?? config.sqlSchema,
    sqlUsername: process.env.SOURCE_SQL_USERNAME || config.sqlUsername,
    sqlPassword: process.env.SOURCE_SQL_PASSWORD || config.sqlPassword,
    sqlSsl: boolEnv("SOURCE_SQL_SSL") ?? config.sqlSsl,
    sqlTrustServerCertificate: boolEnv("SOURCE_SQL_TRUST_SERVER_CERTIFICATE") ?? config.sqlTrustServerCertificate,
    sqlViewPrefix: process.env.SOURCE_SQL_VIEW_PREFIX || config.sqlViewPrefix,
    sqlQueryTimeoutMs: numberEnv("SOURCE_SQL_QUERY_TIMEOUT_MS") ?? config.sqlQueryTimeoutMs,
    sqlMaxRowsPerReport: numberEnv("SOURCE_SQL_MAX_ROWS_PER_REPORT") ?? config.sqlMaxRowsPerReport,
  };
}

function cleanIdentifier(value: string | null | undefined, label: string, allowBlank = false): string {
  const v = String(value ?? "").trim();
  if (!v && allowBlank) return "";
  if (!IDENTIFIER.test(v)) throw new Error(`${label} must contain only letters, numbers and underscores and must not start with a number.`);
  return v;
}

export function configuredSourceMode(config: IntegrationSourceConfig): SourceMode {
  const raw = String(process.env.SOURCE_MODE ?? config.sourceMode ?? "API").trim().toUpperCase();
  if (raw !== "API" && raw !== "SQL") throw new Error(`Unsupported source mode "${raw}". Use API or SQL.`);
  return raw;
}

export function sourceIsConfigured(config: IntegrationSourceConfig): boolean {
  const mode = configuredSourceMode(config);
  const effective = withEnvironment(config);
  if (mode === "API") return Boolean(effective.baseUrl);
  return Boolean(effective.sqlHost && effective.sqlDatabase && effective.sqlUsername && effective.sqlPassword);
}

function canonicalViewParts(config: IntegrationSourceConfig, reportKey: string): { schema: string; view: string } {
  const schema = cleanIdentifier(config.sqlSchema, "SQL schema", true);
  const prefix = cleanIdentifier(config.sqlViewPrefix ?? "v_", "SQL view prefix");
  const report = cleanIdentifier(reportKey, "report key");
  return { schema, view: `${prefix}${report}` };
}

function formatSqlLocation(config: IntegrationSourceConfig, reportKey: string): string {
  const { schema, view } = canonicalViewParts(config, reportKey);
  return schema ? `${schema}.${view}` : view;
}

function normalizeSqlValue(type: string, value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("utf-8");

  if (type === "date") {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value).trim();
    const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return isoDate ?? text;
  }

  if (type === "datetime") {
    if (value instanceof Date) return value.toISOString();
    const text = String(value).trim();
    // Some drivers expose an ISO timestamp without a timezone only when the
    // source view used a timezone-naive type. Do not silently guess UTC here;
    // validation must reject it so the source view can be corrected.
    return text;
  }

  return value;
}

function normalizeSqlRows(reportKey: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const format = getFormat(reportKey);
  if (!format) throw new Error(`Unknown report: ${reportKey}`);

  return rows.map((row) => {
    const lower = new Map<string, unknown>();
    for (const [key, value] of Object.entries(row)) lower.set(key.toLowerCase(), value);
    const out: Record<string, unknown> = {};
    for (const field of format.fields) {
      if (!lower.has(field.name.toLowerCase())) continue;
      out[field.name] = normalizeSqlValue(field.type, lower.get(field.name.toLowerCase()));
    }
    return out;
  });
}

async function createApiAdapter(config: IntegrationSourceConfig): Promise<SourceAdapter> {
  const baseUrl = String(config.baseUrl ?? "").trim();
  if (!baseUrl) throw new Error("No API base URL configured.");
  const token = process.env.SOURCE_API_TOKEN || config.authToken || null;

  async function fetchReport(reportKey: string, window?: SourceWindow): Promise<SourceFetchResult> {
    const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const url = new URL(`api/empower-fin/${reportKey}`, root);
    if (window?.since) url.searchParams.set("since", window.since.toISOString());
    if (window?.through) url.searchParams.set("through", window.through.toISOString());

    const response = await fetch(url, {
      headers: token
        ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
        : { Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${reportKey} endpoint`);

    const body: any = await response.json();
    const records = Array.isArray(body) ? body : body?.records;
    if (!Array.isArray(records)) throw new Error(`${reportKey}: response missing "records" array`);
    return { records, location: url.toString() };
  }

  return {
    mode: "API",
    label: `API ${baseUrl}`,
    fetchReport,
    async test() {
      const result = await fetchReport("employers", { through: new Date() });
      return { ok: true, note: `Connected to API. The employers endpoint returned ${result.records.length} record(s).` };
    },
    async close() {},
  };
}

interface SqlQueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
}

interface SqlExecutor {
  dialect: SqlDialect;
  queryReport(reportKey: string, window: SourceWindow, maxRows: number): Promise<SqlQueryResult>;
  probe(reportKey: string): Promise<string[]>;
  close(): Promise<void>;
}

function quoteSqlIdentifier(dialect: SqlDialect, identifier: string): string {
  cleanIdentifier(identifier, "SQL identifier");
  if (dialect === "MSSQL") return `[${identifier}]`;
  if (dialect === "MYSQL") return `\`${identifier}\``;
  return `"${identifier}"`;
}

function qualifiedView(dialect: SqlDialect, config: IntegrationSourceConfig, reportKey: string): string {
  const { schema, view } = canonicalViewParts(config, reportKey);
  const qView = quoteSqlIdentifier(dialect, view);
  return schema ? `${quoteSqlIdentifier(dialect, schema)}.${qView}` : qView;
}

async function openPostgresExecutor(config: IntegrationSourceConfig): Promise<SqlExecutor> {
  const pg: any = await import("pg");
  const Client = pg.Client ?? pg.default?.Client;
  if (!Client) throw new Error("The pg driver could not be loaded.");

  const queryTimeout = intSetting(config.sqlQueryTimeoutMs, 60_000, 1_000, 600_000);
  const sslEnabled = boolEnv("SOURCE_SQL_SSL") ?? config.sqlSsl ?? true;
  const trust = boolEnv("SOURCE_SQL_TRUST_SERVER_CERTIFICATE") ?? config.sqlTrustServerCertificate ?? false;
  const client = new Client({
    host: config.sqlHost,
    port: intSetting(config.sqlPort, 5432, 1, 65535),
    database: config.sqlDatabase,
    user: config.sqlUsername,
    password: process.env.SOURCE_SQL_PASSWORD || config.sqlPassword,
    ssl: sslEnabled ? { rejectUnauthorized: !trust } : false,
    connectionTimeoutMillis: Math.min(queryTimeout, 60_000),
    statement_timeout: queryTimeout,
    application_name: "empower-fin-dashboard-source",
  });
  await client.connect();

  return {
    dialect: "POSTGRESQL",
    async queryReport(reportKey, window, maxRows) {
      const view = qualifiedView("POSTGRESQL", config, reportKey);
      const params: unknown[] = [];
      const where: string[] = [];
      if (window.since) { params.push(window.since); where.push(`source_updated_at > $${params.length}`); }
      if (window.through) { params.push(window.through); where.push(`source_updated_at <= $${params.length}`); }
      params.push(maxRows + 1);
      const sql = `SELECT * FROM ${view}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY source_updated_at ASC LIMIT $${params.length}`;
      const result = await client.query(sql, params);
      return { rows: result.rows, columns: result.fields?.map((f: any) => String(f.name)) ?? [] };
    },
    async probe(reportKey) {
      const view = qualifiedView("POSTGRESQL", config, reportKey);
      const result = await client.query(`SELECT * FROM ${view} WHERE 1 = 0`);
      return result.fields?.map((f: any) => String(f.name)) ?? [];
    },
    async close() { await client.end(); },
  };
}

async function openMysqlExecutor(config: IntegrationSourceConfig): Promise<SqlExecutor> {
  const mysql: any = await import("mysql2/promise");
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error("The mysql2 driver could not be loaded.");

  const queryTimeout = intSetting(config.sqlQueryTimeoutMs, 60_000, 1_000, 600_000);
  const sslEnabled = boolEnv("SOURCE_SQL_SSL") ?? config.sqlSsl ?? true;
  const trust = boolEnv("SOURCE_SQL_TRUST_SERVER_CERTIFICATE") ?? config.sqlTrustServerCertificate ?? false;
  const connection = await createConnection({
    host: config.sqlHost,
    port: intSetting(config.sqlPort, 3306, 1, 65535),
    database: config.sqlDatabase,
    user: config.sqlUsername,
    password: process.env.SOURCE_SQL_PASSWORD || config.sqlPassword,
    connectTimeout: Math.min(queryTimeout, 60_000),
    ssl: sslEnabled ? { rejectUnauthorized: !trust } : undefined,
    dateStrings: false,
    timezone: "Z",
  });

  return {
    dialect: "MYSQL",
    async queryReport(reportKey, window, maxRows) {
      const view = qualifiedView("MYSQL", config, reportKey);
      const params: unknown[] = [];
      const where: string[] = [];
      if (window.since) { params.push(window.since); where.push("source_updated_at > ?"); }
      if (window.through) { params.push(window.through); where.push("source_updated_at <= ?"); }
      params.push(maxRows + 1);
      const sql = `SELECT * FROM ${view}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY source_updated_at ASC LIMIT ?`;
      const [rows, fields] = await connection.query({ sql, timeout: queryTimeout }, params);
      return {
        rows: Array.isArray(rows) ? rows as Record<string, unknown>[] : [],
        columns: Array.isArray(fields) ? fields.map((f: any) => String(f.name)) : [],
      };
    },
    async probe(reportKey) {
      const view = qualifiedView("MYSQL", config, reportKey);
      const [, fields] = await connection.query({ sql: `SELECT * FROM ${view} WHERE 1 = 0`, timeout: queryTimeout });
      return Array.isArray(fields) ? fields.map((f: any) => String(f.name)) : [];
    },
    async close() { await connection.end(); },
  };
}

async function openMssqlExecutor(config: IntegrationSourceConfig): Promise<SqlExecutor> {
  const mssql: any = await import("mssql");
  const ConnectionPool = mssql.ConnectionPool ?? mssql.default?.ConnectionPool;
  if (!ConnectionPool) throw new Error("The mssql driver could not be loaded.");

  const queryTimeout = intSetting(config.sqlQueryTimeoutMs, 60_000, 1_000, 600_000);
  const encrypt = boolEnv("SOURCE_SQL_SSL") ?? config.sqlSsl ?? true;
  const trust = boolEnv("SOURCE_SQL_TRUST_SERVER_CERTIFICATE") ?? config.sqlTrustServerCertificate ?? false;
  const pool = await new ConnectionPool({
    server: config.sqlHost,
    port: intSetting(config.sqlPort, 1433, 1, 65535),
    database: config.sqlDatabase,
    user: config.sqlUsername,
    password: process.env.SOURCE_SQL_PASSWORD || config.sqlPassword,
    connectionTimeout: Math.min(queryTimeout, 60_000),
    requestTimeout: queryTimeout,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
    options: { encrypt, trustServerCertificate: trust, enableArithAbort: true, useUTC: true },
  }).connect();

  return {
    dialect: "MSSQL",
    async queryReport(reportKey, window, maxRows) {
      const view = qualifiedView("MSSQL", config, reportKey);
      const request = pool.request();
      request.input("limit", mssql.Int, maxRows + 1);
      const where: string[] = [];
      if (window.since) { request.input("since", mssql.DateTimeOffset, window.since); where.push("source_updated_at > @since"); }
      if (window.through) { request.input("through", mssql.DateTimeOffset, window.through); where.push("source_updated_at <= @through"); }
      const sql = `SELECT TOP (@limit) * FROM ${view}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY source_updated_at ASC`;
      const result = await request.query(sql);
      const rows = Array.isArray(result.recordset) ? result.recordset as Record<string, unknown>[] : [];
      const columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : (rows[0] ? Object.keys(rows[0]) : []);
      return { rows, columns };
    },
    async probe(reportKey) {
      const view = qualifiedView("MSSQL", config, reportKey);
      const result = await pool.request().query(`SELECT TOP (0) * FROM ${view}`);
      if (result.recordset?.columns) return Object.keys(result.recordset.columns);
      return [];
    },
    async close() { await pool.close(); },
  };
}

function sqlDialect(config: IntegrationSourceConfig): SqlDialect {
  const raw = String(config.sqlDialect ?? "POSTGRESQL").trim().toUpperCase();
  if (raw === "POSTGRES" || raw === "PG") return "POSTGRESQL";
  if (raw === "SQLSERVER" || raw === "SQL_SERVER") return "MSSQL";
  if (raw !== "POSTGRESQL" && raw !== "MSSQL" && raw !== "MYSQL") {
    throw new Error(`Unsupported SQL dialect "${raw}". Use POSTGRESQL, MSSQL or MYSQL.`);
  }
  return raw;
}

async function createSqlAdapter(config: IntegrationSourceConfig): Promise<SourceAdapter> {
  if (!config.sqlHost) throw new Error("SQL host is required.");
  if (!config.sqlDatabase) throw new Error("SQL database/catalog is required.");
  if (!config.sqlUsername) throw new Error("SQL read-only username is required.");
  if (!(process.env.SOURCE_SQL_PASSWORD || config.sqlPassword)) throw new Error("SQL password is required. Set it in Admin or SOURCE_SQL_PASSWORD.");

  const dialect = sqlDialect(config);
  const maxRows = intSetting(config.sqlMaxRowsPerReport, 250_000, 1, 2_000_000);
  let executor: SqlExecutor;
  if (dialect === "POSTGRESQL") executor = await openPostgresExecutor(config);
  else if (dialect === "MYSQL") executor = await openMysqlExecutor(config);
  else executor = await openMssqlExecutor(config);

  async function fetchReport(reportKey: string, window: SourceWindow = {}): Promise<SourceFetchResult> {
    const result = await executor.queryReport(reportKey, window, maxRows);
    if (result.rows.length > maxRows) {
      throw new Error(`${reportKey}: SQL extraction exceeded the configured ${maxRows.toLocaleString("en-ZA")} row safety limit for one sync window. Increase sync frequency or sqlMaxRowsPerReport.`);
    }
    return {
      records: normalizeSqlRows(reportKey, result.rows),
      location: `${dialect}:${formatSqlLocation(config, reportKey)}`,
    };
  }

  return {
    mode: "SQL",
    label: `${dialect} ${config.sqlHost}/${config.sqlDatabase}`,
    fetchReport,
    async test() {
      const details: Record<string, unknown> = {};
      for (const reportKey of LOAD_ORDER) {
        const format = getFormat(reportKey)!;
        const columns = await executor.probe(reportKey);
        const available = new Set(columns.map((c) => c.toLowerCase()));
        const missing = format.fields.map((f) => f.name).filter((name) => !available.has(name.toLowerCase()));
        details[reportKey] = { view: formatSqlLocation(config, reportKey), columns: columns.length, missing };
        if (missing.length) {
          throw new Error(`${formatSqlLocation(config, reportKey)} is missing canonical column(s): ${missing.join(", ")}`);
        }
      }
      return {
        ok: true,
        note: `Connected to ${dialect}. All ${LOAD_ORDER.length} canonical SQL views are accessible and expose the contracted columns.`,
        details,
      };
    },
    async close() { await executor.close(); },
  };
}

export async function createSourceAdapter(config: IntegrationSourceConfig): Promise<SourceAdapter> {
  const mode = configuredSourceMode(config);
  const effective = withEnvironment(config);
  return mode === "SQL" ? createSqlAdapter(effective) : createApiAdapter(effective);
}
