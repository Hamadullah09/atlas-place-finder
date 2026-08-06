import { config } from '../config.js';
import type { SearchResult } from '../types.js';

export interface HistoryEntry {
  searchId: string;
  keyword: string;
  city: string;
  country: string;
  resultCount: number;
  createdAt: string;
}

export interface SearchStore {
  readonly kind: 'postgres' | 'memory';
  get(cacheKey: string): Promise<SearchResult | null>;
  getById(searchId: string): Promise<SearchResult | null>;
  save(cacheKey: string, result: SearchResult): Promise<void>;
  history(limit: number): Promise<HistoryEntry[]>;
  close(): Promise<void>;
}

export function cacheKeyFor(
  keyword: string,
  city: string,
  country: string,
  limit: number,
  useLlm: boolean,
  source: 'osm' | 'google' = 'osm',
): string {
  return [keyword, city, country, limit, useLlm ? 'llm' : 'raw', source]
    .map((part) => String(part).trim().toLowerCase())
    .join('|');
}

// ---------------------------------------------------------------------------
// In-memory (default)
// ---------------------------------------------------------------------------

class MemoryStore implements SearchStore {
  readonly kind = 'memory' as const;
  private readonly byKey = new Map<string, { result: SearchResult; expiresAt: number }>();
  private readonly byId = new Map<string, { result: SearchResult; expiresAt: number }>();
  private readonly maxEntries = 200;

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.byKey) if (entry.expiresAt <= now) this.byKey.delete(key);
    for (const [id, entry] of this.byId) if (entry.expiresAt <= now) this.byId.delete(id);

    // Map preserves insertion order, so the first key is the oldest.
    while (this.byKey.size > this.maxEntries) {
      const oldest = this.byKey.keys().next().value;
      if (oldest === undefined) break;
      this.byKey.delete(oldest);
    }
    while (this.byId.size > this.maxEntries) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  async get(cacheKey: string): Promise<SearchResult | null> {
    this.prune();
    const entry = this.byKey.get(cacheKey);
    return entry && entry.expiresAt > Date.now() ? entry.result : null;
  }

  async getById(searchId: string): Promise<SearchResult | null> {
    this.prune();
    const entry = this.byId.get(searchId);
    return entry && entry.expiresAt > Date.now() ? entry.result : null;
  }

  async save(cacheKey: string, result: SearchResult): Promise<void> {
    const entry = { result, expiresAt: Date.now() + config.cacheTtlMs };
    this.byKey.delete(cacheKey);
    this.byKey.set(cacheKey, entry);
    this.byId.set(result.searchId, entry);
    this.prune();
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    this.prune();
    return [...this.byId.values()]
      .map(({ result }) => ({
        searchId: result.searchId,
        keyword: result.query.keyword,
        city: result.query.city,
        country: result.query.country,
        resultCount: result.places.length,
        createdAt: result.cachedAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async close(): Promise<void> {
    this.byKey.clear();
    this.byId.clear();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL (opt-in via DATABASE_URL)
// ---------------------------------------------------------------------------

const SCHEMA = `
create table if not exists searches (
  id           uuid primary key,
  cache_key    text        not null,
  keyword      text        not null,
  city         text        not null,
  country      text        not null,
  result_count integer     not null default 0,
  payload      jsonb       not null,
  created_at   timestamptz not null default now()
);
create index if not exists searches_cache_key_idx on searches (cache_key, created_at desc);
create index if not exists searches_created_at_idx on searches (created_at desc);
`;

class PostgresStore implements SearchStore {
  readonly kind = 'postgres' as const;

  private constructor(private readonly pool: import('pg').Pool) {}

  static async create(connectionString: string): Promise<PostgresStore> {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query(SCHEMA);
    return new PostgresStore(pool);
  }

  private toResult(row: { payload: SearchResult }): SearchResult {
    return row.payload;
  }

  async get(cacheKey: string): Promise<SearchResult | null> {
    const { rows } = await this.pool.query<{ payload: SearchResult }>(
      `select payload from searches
        where cache_key = $1 and created_at > now() - ($2::bigint * interval '1 millisecond')
        order by created_at desc limit 1`,
      [cacheKey, config.cacheTtlMs],
    );
    return rows[0] ? this.toResult(rows[0]) : null;
  }

  async getById(searchId: string): Promise<SearchResult | null> {
    // Guard: a non-uuid would make Postgres throw rather than return no rows.
    if (!/^[0-9a-f-]{36}$/i.test(searchId)) return null;
    const { rows } = await this.pool.query<{ payload: SearchResult }>(
      'select payload from searches where id = $1 limit 1',
      [searchId],
    );
    return rows[0] ? this.toResult(rows[0]) : null;
  }

  async save(cacheKey: string, result: SearchResult): Promise<void> {
    await this.pool.query(
      `insert into searches (id, cache_key, keyword, city, country, result_count, payload)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set payload = excluded.payload, created_at = now()`,
      [
        result.searchId,
        cacheKey,
        result.query.keyword,
        result.query.city,
        result.query.country,
        result.places.length,
        JSON.stringify(result),
      ],
    );
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    const { rows } = await this.pool.query<{
      id: string; keyword: string; city: string; country: string;
      result_count: number; created_at: Date;
    }>(
      `select id, keyword, city, country, result_count, created_at
         from searches order by created_at desc limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      searchId: row.id,
      keyword: row.keyword,
      city: row.city,
      country: row.country,
      resultCount: row.result_count,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let storePromise: Promise<SearchStore> | null = null;

/** Postgres when DATABASE_URL is set and reachable, otherwise in-memory. */
export function getStore(): Promise<SearchStore> {
  if (storePromise) return storePromise;

  storePromise = (async (): Promise<SearchStore> => {
    if (!config.databaseUrl) return new MemoryStore();
    try {
      const store = await PostgresStore.create(config.databaseUrl);
      console.log('[cache] using PostgreSQL for search history');
      return store;
    } catch (error) {
      console.warn(
        `[cache] PostgreSQL unavailable (${error instanceof Error ? error.message : String(error)}); falling back to in-memory cache`,
      );
      return new MemoryStore();
    }
  })();

  return storePromise;
}
