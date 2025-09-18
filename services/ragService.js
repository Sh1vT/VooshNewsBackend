// backend/services/ragService.js
/**
 * RAG service — uses Jina embeddings (HTTP) + Qdrant REST search.
 *
 * Exports:
 *   - getContextWithHits(query, top_k = 5)
 *
 * Environment variables expected (same style as your other services):
 *   JINA_API_KEY       - required (for jina.ai HTTP embedding)
 *   JINA_MODEL         - optional (defaults to jina-embeddings-v2-base-en)
 *   QDRANT_HOST        - required, full URL e.g. https://<host>:6333 or https://<cloud-host>
 *   QDRANT_API_KEY     - optional (if your Qdrant requires an API key)
 *   COLLECTION_NAME    - optional (default voosh_news_v1)
 *
 * Notes:
 *  - This implementation uses global fetch (Node 18+). If your Node version lacks fetch,
 *    install node-fetch and adapt the top of this file.
 */

import assert from "assert";

const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_MODEL = process.env.JINA_MODEL || "jina-embeddings-v2-base-en";

const QDRANT_HOST = process.env.QDRANT_HOST;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "voosh_news_v1";

if (!JINA_API_KEY) {
  console.warn("[RAG] JINA_API_KEY not set — embedding calls will fail until configured.");
}
if (!QDRANT_HOST) {
  throw new Error("QDRANT_HOST must be defined in env");
}

// small helper to perform HTTP fetch with optional Qdrant API key and JSON handling
async function httpPost(url, bodyObj, headers = {}, timeoutMs = 30_000) {
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(bodyObj),
  };

  // attach Qdrant API key if provided
  if (QDRANT_API_KEY && url.startsWith(QDRANT_HOST)) {
    // Qdrant cloud sometimes expects 'api-key' header
    opts.headers["api-key"] = QDRANT_API_KEY;
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      // not JSON
    }
    if (!res.ok) {
      const errMsg = `HTTP ${res.status} ${res.statusText} from ${url} - body: ${text}`;
      const err = new Error(errMsg);
      err.__raw = { status: res.status, body: text, parsed: json };
      throw err;
    }
    return json;
  } finally {
    clearTimeout(id);
  }
}

/* -------------------------
   Jina embedding wrapper (HTTP)
   -------------------------
   Uses: POST https://api.jina.ai/v1/embeddings
   Body: { model: "<model>", input: ["...", ...] }
   Response: { data: [{ embedding: [...] }, ...], ... }
*/
async function embedWithJina(texts = []) {
  if (!Array.isArray(texts)) texts = [String(texts)];
  if (!JINA_API_KEY) throw new Error("JINA_API_KEY not configured");

  const url = "https://api.jina.ai/v1/embeddings";
  const headers = {
    Authorization: `Bearer ${JINA_API_KEY}`,
  };
  const body = { model: JINA_MODEL, input: texts };

  try {
    const json = await httpPost(url, body, headers, 30_000);
    if (!json) throw new Error("Empty response from Jina embeddings");
    if (Array.isArray(json.data)) {
      const embeddings = json.data.map((item, i) => {
        if (item && Array.isArray(item.embedding)) return item.embedding;
        // Try other shapes
        if (item && item.values && Array.isArray(item.values)) return item.values;
        throw new Error(`Unexpected embedding item shape at index ${i}: ${JSON.stringify(item).slice(0,200)}`);
      });
      return embeddings;
    }
    // fallback if API returns direct list of vectors
    if (Array.isArray(json)) return json;
    throw new Error("Unrecognized Jina response shape for embeddings");
  } catch (err) {
    // bubble up with context
    console.error("[RAG][JINA] embed error:", err?.message || err);
    throw err;
  }
}

/* -------------------------
   Qdrant search wrapper (REST)
   -------------------------
   Uses /collections/{collection}/points/search or /collections/{collection}/points/search
   We call the search API with a vector and get payloads back.
*/
async function qdrantSearchByVector(vector, topK = 5) {
  assert(Array.isArray(vector) && vector.length > 0, "vector must be non-empty array");
  const url = `${QDRANT_HOST.replace(/\/$/, "")}/collections/${encodeURIComponent(COLLECTION_NAME)}/points/search`;
  const body = {
    vector,
    // use 'limit' field for number of neighbors
    limit: Math.max(1, Number(topK) || 5),
    with_payload: true,
    with_vector: false,
  };

  try {
    const json = await httpPost(url, body, {}, 30_000);
    // Qdrant typical response: {result: [{id, payload, score}, ...], status: 'ok'}
    const hits = Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : [];
    return hits.map((h) => ({
      id: h.id,
      score: h.score ?? h.payload?.score ?? null,
      payload: h.payload ?? {},
    }));
  } catch (err) {
    console.error("[RAG][QDRANT] search error:", err?.message || err);
    throw err;
  }
}

/* -------------------------
   getContextWithHits(query, top_k)
   - Embeds query with Jina
   - Searches Qdrant for top_k
   - Builds a single 'context' string containing top passages concatenated
   - Returns { context, hits, top_k_used }
*/
export async function getContextWithHits(query, top_k = 5) {
  const topK = Number(top_k) || 5;
  if (!query || String(query).trim().length === 0) {
    return { context: "", hits: [], top_k_used: 0 };
  }

  // 1) embed the query
  let qVec;
  try {
    const embeddings = await embedWithJina([String(query)]);
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error("Empty embedding returned from Jina");
    }
    qVec = embeddings[0];
  } catch (err) {
    console.warn("[RAG] Embedding failed:", err?.message || err);
    // return empty context so caller can fallback gracefully
    return { context: "", hits: [], top_k_used: 0 };
  }

  // 2) query Qdrant
  let hits = [];
  try {
    hits = await qdrantSearchByVector(qVec, topK);
  } catch (err) {
    console.warn("[RAG] Qdrant search failed:", err?.message || err);
    return { context: "", hits: [], top_k_used: 0 };
  }

  // 3) Build context: choose a readable concatenation of top passages (limit length)
  //    Each hit.payload is expected to have `text` and `url` fields (based on your indexer).
  const MAX_CONTEXT_CHARS = 4000; // tune for model prompt size
  const parts = [];
  for (const h of hits) {
    const text = (h.payload && (h.payload.text || h.payload.excerpt || h.payload.content)) || "";
    const title = (h.payload && (h.payload.title || h.payload.headline)) || null;
    const source = (h.payload && (h.payload.url || h.payload.source)) || null;
    let snippet = text;
    if (snippet && snippet.length > 2000) snippet = snippet.slice(0, 2000) + "…";
    let piece = "";
    if (title) piece += `${title}\n`;
    if (snippet) piece += `${snippet}\n`;
    if (source) piece += `Source: ${source}\n`;
    if (piece.trim()) parts.push(piece.trim());
    // stop if context would grow too large
    const curLen = parts.join("\n\n").length;
    if (curLen >= MAX_CONTEXT_CHARS) break;
  }

  const context = parts.join("\n\n");
  return { context, hits, top_k_used: hits.length };
}

/* -------------------------
   Optional helper: getContextAndAnswer(query, askFunction)
   - Convenience wrapper that builds context and calls a model-asking function (e.g. Gemini or other)
   - Not exported by default, but you can use it in your higher-level handlers.
*/
export async function getContextAndAnswer(query, askFn, top_k = 5, options = {}) {
  const { context, hits, top_k_used } = await getContextWithHits(query, top_k);
  let answer = "Sorry, something went wrong.";
  if (!context || context.length === 0) {
    return { answer, context, hits, top_k_used };
  }
  try {
    // askFn should be a function like askGemini(query, context)
    answer = await askFn(query, context, options);
  } catch (err) {
    console.warn("[RAG] askFn error:", err?.message || err);
    answer = "Sorry, I couldn't generate a response.";
  }
  return { answer, context, hits, top_k_used };
}

/* -------------------------
   Quick local test helper (uncomment to run locally)
   -------------------------
(async () => {
  try {
    const res = await getContextWithHits("Who is the president of France?", 5);
    console.log("context len:", res.context.length, "hits:", res.hits.length);
  } catch (e) {
    console.error(e);
  }
})();
*/

export default {
  getContextWithHits,
  getContextAndAnswer,
};
