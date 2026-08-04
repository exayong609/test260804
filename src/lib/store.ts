import { promises as fs } from "fs";
import path from "path";
import postgres from "postgres";
import { DEFAULT_RULES } from "@/lib/default-rules";
import type { LlmProfile, LlmProfileView, LlmProtocol, OrderGroup, ParsingRule } from "@/types";

type LocalStore = {
  rules: ParsingRule[];
  orders: OrderGroup[];
  llmProfiles?: LlmProfile[];
};

const storePath = process.env.VERCEL
  ? path.join("/tmp", "universal-order-importer-store.json")
  : path.join(process.cwd(), "data", "local-store.json");

let sqlClient: ReturnType<typeof postgres> | null = null;
let schemaReady: Promise<void> | null = null;

function withDefaultRules(rules: ParsingRule[]) {
  const defaultIds = new Set(DEFAULT_RULES.map((rule) => rule.id));
  return [...rules.filter((rule) => !defaultIds.has(rule.id)), ...DEFAULT_RULES.map((rule) => ({ ...rule, builtIn: true }))];
}

export function getSql() {
  if (!process.env.DATABASE_URL) return null;
  const configuredMax = Number(process.env.DATABASE_POOL_MAX || 10);
  sqlClient ||= postgres(process.env.DATABASE_URL, {
    max: Number.isFinite(configuredMax) ? Math.max(1, Math.min(configuredMax, 40)) : 10,
    onnotice: () => undefined
  });
  return sqlClient;
}

function normalizeProtocol(protocol?: string): LlmProtocol {
  if (protocol === "minimax-native") return "minimax-native";
  return protocol === "anthropic-compatible" ? "anthropic-compatible" : "openai-compatible";
}

function normalizeProfile(profile: LlmProfile): LlmProfile {
  return { ...profile, protocol: normalizeProtocol(profile.protocol) };
}

async function readLocal(): Promise<LocalStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as LocalStore;
    return { rules: parsed.rules || [], orders: parsed.orders || [], llmProfiles: parsed.llmProfiles || [] };
  } catch {
    return { rules: [], orders: [], llmProfiles: [] };
  }
}

async function writeLocal(store: LocalStore) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function initializeSchema() {
  const sql = getSql();
  if (!sql) return;
  await sql`
    create table if not exists parsing_rules (
      id text primary key,
      name text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists imported_orders (
      id text primary key,
      external_code text,
      recipient_name text,
      store_name text,
      submitted_at timestamptz not null,
      payload jsonb not null
    )
  `;
  await sql`
    create table if not exists llm_profiles (
      id text primary key,
      name text not null,
      protocol text not null default 'openai-compatible',
      base_url text not null,
      model text not null,
      api_key text not null,
      temperature double precision,
      timeout_ms integer,
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`alter table llm_profiles add column if not exists protocol text not null default 'openai-compatible'`;
}

export async function ensureSchema() {
  if (!getSql()) return;
  schemaReady ||= initializeSchema().catch((error) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

function toProfileView(profile: LlmProfile, source: LlmProfileView["source"] = "stored"): LlmProfileView {
  const { apiKey: _apiKey, ...rest } = profile;
  return { ...rest, hasApiKey: Boolean(profile.apiKey), source };
}

function envProfile(): LlmProfile | null {
  if (!process.env.LLM_API_KEY) return null;
  const now = new Date().toISOString();
  return {
    id: "env-default",
    name: "环境变量默认 Profile",
    protocol: normalizeProtocol(process.env.LLM_PROTOCOL),
    baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
    model: process.env.LLM_MODEL || "deepseek-chat",
    apiKey: process.env.LLM_API_KEY,
    temperature: 0.1,
    timeoutMs: 25000,
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
}

export async function listLlmProfileViews(): Promise<LlmProfileView[]> {
  const sql = getSql();
  const env = envProfile();
  if (sql) {
    await ensureSchema();
    const rows = await sql<
      {
        id: string;
        name: string;
        protocol: string;
        base_url: string;
        model: string;
        api_key: string;
        temperature: number | null;
        timeout_ms: number | null;
        enabled: boolean;
        created_at: Date;
        updated_at: Date;
      }[]
    >`select id, name, protocol, base_url, model, api_key, temperature, timeout_ms, enabled, created_at, updated_at from llm_profiles order by updated_at desc`;
    const stored = rows.map((row) =>
      toProfileView({
        id: row.id,
        name: row.name,
        protocol: normalizeProtocol(row.protocol),
        baseUrl: row.base_url,
        model: row.model,
        apiKey: row.api_key,
        temperature: row.temperature ?? undefined,
        timeoutMs: row.timeout_ms ?? undefined,
        enabled: row.enabled,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      })
    );
    return env ? [toProfileView(env, "env"), ...stored] : stored;
  }
  const store = await readLocal();
  const stored = (store.llmProfiles || []).map((profile) => toProfileView(normalizeProfile(profile)));
  return env ? [toProfileView(env, "env"), ...stored] : stored;
}

export async function getLlmProfile(id?: string): Promise<LlmProfile | null> {
  if (!id || id === "env-default") return envProfile();
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    const rows = await sql<
      {
        id: string;
        name: string;
        protocol: string;
        base_url: string;
        model: string;
        api_key: string;
        temperature: number | null;
        timeout_ms: number | null;
        enabled: boolean;
        created_at: Date;
        updated_at: Date;
      }[]
    >`select id, name, protocol, base_url, model, api_key, temperature, timeout_ms, enabled, created_at, updated_at from llm_profiles where id = ${id} limit 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      protocol: normalizeProtocol(row.protocol),
      baseUrl: row.base_url,
      model: row.model,
      apiKey: row.api_key,
      temperature: row.temperature ?? undefined,
      timeoutMs: row.timeout_ms ?? undefined,
      enabled: row.enabled,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }
  const store = await readLocal();
  const profile = (store.llmProfiles || []).find((item) => item.id === id);
  return profile ? normalizeProfile(profile) : null;
}

export async function saveLlmProfile(profile: LlmProfile) {
  const now = new Date().toISOString();
  const updatedProfile = {
    ...profile,
    protocol: normalizeProtocol(profile.protocol),
    createdAt: profile.createdAt || now,
    updatedAt: now,
    temperature: profile.temperature ?? 0.1,
    timeoutMs: profile.timeoutMs ?? 25000,
    enabled: profile.enabled ?? true
  };
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    await sql`
      insert into llm_profiles (id, name, protocol, base_url, model, api_key, temperature, timeout_ms, enabled, created_at, updated_at)
      values (
        ${updatedProfile.id},
        ${updatedProfile.name},
        ${updatedProfile.protocol},
        ${updatedProfile.baseUrl},
        ${updatedProfile.model},
        ${updatedProfile.apiKey},
        ${updatedProfile.temperature},
        ${updatedProfile.timeoutMs},
        ${updatedProfile.enabled},
        ${updatedProfile.createdAt},
        ${updatedProfile.updatedAt}
      )
      on conflict (id) do update set
        name = excluded.name,
        protocol = excluded.protocol,
        base_url = excluded.base_url,
        model = excluded.model,
        api_key = excluded.api_key,
        temperature = excluded.temperature,
        timeout_ms = excluded.timeout_ms,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `;
    return updatedProfile;
  }
  const store = await readLocal();
  const profiles = store.llmProfiles || [];
  const index = profiles.findIndex((item) => item.id === updatedProfile.id);
  if (index >= 0) profiles[index] = updatedProfile;
  else profiles.unshift(updatedProfile);
  await writeLocal({ ...store, llmProfiles: profiles });
  return updatedProfile;
}

export async function deleteLlmProfile(id: string) {
  if (id === "env-default") return;
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    await sql`delete from llm_profiles where id = ${id}`;
    return;
  }
  const store = await readLocal();
  await writeLocal({ ...store, llmProfiles: (store.llmProfiles || []).filter((profile) => profile.id !== id) });
}

export async function listRules(): Promise<ParsingRule[]> {
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    const rows = await sql<{ payload: ParsingRule }[]>`select payload from parsing_rules order by updated_at desc`;
    return withDefaultRules(rows.map((row) => row.payload));
  }
  const rules = (await readLocal()).rules;
  return withDefaultRules(rules);
}

export async function saveRule(rule: ParsingRule) {
  const sql = getSql();
  const updatedRule = { ...rule, updatedAt: new Date().toISOString() };
  if (sql) {
    await ensureSchema();
    await sql`
      insert into parsing_rules (id, name, payload, created_at, updated_at)
      values (${updatedRule.id}, ${updatedRule.name}, ${sql.json(updatedRule)}, ${updatedRule.createdAt}, ${updatedRule.updatedAt})
      on conflict (id) do update set
        name = excluded.name,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `;
    return updatedRule;
  }
  const store = await readLocal();
  const index = store.rules.findIndex((item) => item.id === updatedRule.id);
  if (index >= 0) store.rules[index] = updatedRule;
  else store.rules.unshift(updatedRule);
  await writeLocal(store);
  return updatedRule;
}

export async function deleteRule(id: string) {
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    await sql`delete from parsing_rules where id = ${id}`;
    return;
  }
  const store = await readLocal();
  store.rules = store.rules.filter((rule) => rule.id !== id);
  await writeLocal(store);
}

export async function restoreDefaultRule(id: string) {
  const defaultRule = DEFAULT_RULES.find((rule) => rule.id === id);
  if (!defaultRule) throw new Error("只能恢复内置规则。");
  await deleteRule(id);
  return { ...defaultRule, builtIn: true };
}

export async function listOrders(params: { query?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
  const toExclusive = params.to ? new Date(`${params.to}T00:00:00.000Z`) : null;
  if (toExclusive) toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    const query = `%${params.query || ""}%`;
    const rows = await sql<{ payload: OrderGroup; total: number }[]>`
      select payload, count(*) over()::int as total
      from imported_orders
      where (${params.query || ""} = '' or external_code ilike ${query} or recipient_name ilike ${query} or store_name ilike ${query})
        and (${params.from || ""} = '' or submitted_at >= ${params.from || "1970-01-01"}::timestamptz)
        and (${params.to || ""} = '' or submitted_at < ${toExclusive?.toISOString() || "2999-01-01T00:00:00.000Z"}::timestamptz)
      order by submitted_at desc
      limit ${pageSize}
      offset ${(page - 1) * pageSize}
    `;
    return { items: rows.map((row) => row.payload), total: rows[0]?.total || 0 };
  }

  const store = await readLocal();
  let items = store.orders;
  if (params.query) {
    const q = params.query.toLowerCase();
    items = items.filter((item) =>
      [item.externalCode, item.recipientName, item.storeName].some((value) => String(value || "").toLowerCase().includes(q))
    );
  }
  if (params.from) items = items.filter((item) => (item.submittedAt || "") >= params.from!);
  if (toExclusive) items = items.filter((item) => (item.submittedAt || "") < toExclusive.toISOString());
  const total = items.length;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total };
}

export async function existingExternalCodes() {
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    const rows = await sql<{ external_code: string }[]>`select external_code from imported_orders where external_code is not null`;
    return rows.map((row) => row.external_code).filter(Boolean);
  }
  const store = await readLocal();
  return store.orders.map((order) => order.externalCode).filter(Boolean) as string[];
}

export async function saveOrders(orders: OrderGroup[]) {
  const submittedAt = new Date().toISOString();
  const normalized = orders.map((order) => ({ ...order, submittedAt }));
  const sql = getSql();
  if (sql) {
    await ensureSchema();
    for (const order of normalized) {
      await sql`
        insert into imported_orders (id, external_code, recipient_name, store_name, submitted_at, payload)
        values (${order.id}, ${order.externalCode || null}, ${order.recipientName || null}, ${order.storeName || null}, ${submittedAt}, ${sql.json(order)})
        on conflict (id) do update set payload = excluded.payload, submitted_at = excluded.submitted_at
      `;
    }
    return normalized;
  }
  const store = await readLocal();
  store.orders.unshift(...normalized);
  await writeLocal(store);
  return normalized;
}
