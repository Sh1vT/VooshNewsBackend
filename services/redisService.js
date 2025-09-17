// backend/services/redisService.js
import Redis from "ioredis";
import { getContextWithHits } from "./ragService.js";
import { askGemini } from "./geminiService.js";

/**
 * Redis client initialization:
 * - Only create client if REDIS_URL is defined.
 * - Support rediss:// URLs for TLS providers.
 * - Do NOT fall back to localhost unless you explicitly add one.
 */
const REDIS_URL = process.env.REDIS_URL || "";
if (!REDIS_URL) {
  console.log("[redis] REDIS_URL not defined — redis client will remain uninitialized.");
}

let redis = null;
if (REDIS_URL) {
  console.log("[redis] creating redis client (masked):", REDIS_URL.replace(/:.+@/, ":***@"));
  // If URL starts with rediss:// or REDIS_TLS env set, ioredis will handle TLS for rediss
  redis = new Redis(REDIS_URL, REDIS_URL.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : undefined);
  redis.on("connect", () => console.log("[redis] connected"));
  redis.on("ready", () => console.log("[redis] ready"));
  redis.on("error", (err) => console.warn("[redis] error:", err.message));
}

/* Safe wrappers that no-op when redis is not configured */
async function safeAppendChat(key, value, maxLen = 1000, ttlSeconds = 60 * 60 * 24 * 30) {
  if (!redis) {
    console.warn("[redis] safeAppendChat skipped (no redis client) for key:", key);
    return;
  }
  try {
    // rpush, keep only last maxLen and set TTL
    await redis.multi()
      .rpush(key, value)
      .ltrim(key, -maxLen, -1)
      .expire(key, ttlSeconds)
      .exec();
  } catch (e) {
    console.warn("[redis] safeAppendChat failed:", e?.message || e);
  }
}

async function safeLRange(key, start = 0, stop = -1) {
  if (!redis) return [];
  try {
    return await redis.lrange(key, start, stop);
  } catch (e) {
    console.warn("[redis] lrange failed:", e?.message || e);
    return [];
  }
}

async function safeDel(key) {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (e) {
    console.warn("[redis] del failed:", e?.message || e);
  }
}

/* Simple context-match heuristic (token-level) used for an optional retry.
   returns true if at least one long query token appears in context. */
function contextMatchesQuery(context, query) {
  if (!context) return false;
  const qTokens = query.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  const lower = context.toLowerCase();
  return qTokens.some(t => lower.includes(t));
}

/**
 * handleChat(sessionId, query)
 * - obtains RAG context
 * - retries with larger top_k if necessary
 * - calls Gemini via askGemini
 * - stores a JSON entry in Redis list key `chat:<sessionId>` using safeAppendChat
 */
export async function handleChat(sessionId, query) {
  const DEFAULT_TOP_K = Number(process.env.TOP_K || 5);

  // get context & hits
  let { context, hits, top_k_used } = await getContextWithHits(query, DEFAULT_TOP_K);

  // optional retry with larger top_k
  if (!contextMatchesQuery(context, query) && top_k_used < 20) {
    const retryK = Math.min(20, DEFAULT_TOP_K * 4);
    console.log(`[RAG] retrying with top_k=${retryK}`);
    const retryRes = await getContextWithHits(query, retryK);
    context = retryRes.context;
    hits = retryRes.hits;
    top_k_used = retryRes.top_k_used;
  }

  // ask Gemini
  let answer;
  try {
    answer = await askGemini(query, context);
  } catch (e) {
    console.warn("[GEMINI] askGemini error:", e?.message || e);
    answer = "Sorry, I couldn't generate a response.";
  }

  // store entry (context summary kept short)
  const entry = {
    query,
    answer,
    context_summary: context ? context.slice(0, 500) : "",
    timestamp: Date.now(),
  };

  await safeAppendChat(`chat:${sessionId}`, JSON.stringify(entry));

  return { answer, context, hits, top_k_used };
}

/**
 * getHistory(sessionId)
 */
export async function getHistory(sessionId) {
  const raw = await safeLRange(`chat:${sessionId}`, 0, -1);
  return raw.map((r) => {
    try { return JSON.parse(r); } catch { return { raw: r }; }
  });
}

/**
 * clearHistory(sessionId)
 */
export async function clearHistory(sessionId) {
  await safeDel(`chat:${sessionId}`);
}
