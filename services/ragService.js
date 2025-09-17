// services/ragService.js
// Final drop-in RAG service — lazy init, Cohere v2, Qdrant js client
// Exports: getContextWithHits (existing), qdrantClient(), cfg()

import { CohereClientV2 } from "cohere-ai";
import { QdrantClient } from "@qdrant/js-client-rest";

/* singletons for lazy init */
let _cohere = null;
let _qdrant = null;
let _cfg = null;

export function cfg() {
  if (_cfg) return _cfg;
  _cfg = {
    CO_API_KEY: process.env.CO_API_KEY || process.env.COHERE_API_KEY,
    COHERE_MODEL: process.env.COHERE_MODEL || process.env.COHERE_MODEL || process.env.EMBEDDING_MODEL || "embed-english-light-v3.0",
    COHERE_TIMEOUT_MS: parseInt(process.env.COHERE_TIMEOUT_MS || "15000", 10),

    QDRANT_HOST: process.env.QDRANT_HOST,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY || undefined,
    COLLECTION_NAME: process.env.COLLECTION_NAME || "voosh_news_v1",
    QDRANT_TIMEOUT_MS: parseInt(process.env.QDRANT_TIMEOUT_MS || "15000", 10),

    DEFAULT_TOP_K: parseInt(process.env.DEFAULT_TOP_K || "5", 10),

    // tuneable runtime params
    MAX_CONTEXT_CHARS: parseInt(process.env.MAX_CONTEXT_CHARS || "1500", 10),
    MAX_HITS_TO_CONSIDER: parseInt(process.env.MAX_HITS_TO_CONSIDER || "20", 10),
    MAX_HITS_IN_CONTEXT: parseInt(process.env.MAX_HITS_IN_CONTEXT || "5", 10),
    TITLE_BOOST_ALPHA: parseFloat(process.env.TITLE_BOOST_ALPHA || "0.12"),
  };
  return _cfg;
}

export function cohereClient() {
  if (_cohere) return _cohere;
  const c = cfg();
  _cohere = new CohereClientV2({ token: c.CO_API_KEY });
  return _cohere;
}

export function qdrantClient() {
  if (_qdrant) return _qdrant;
  const c = cfg();
  _qdrant = c.QDRANT_HOST
    ? new QdrantClient({ url: c.QDRANT_HOST, apiKey: c.QDRANT_API_KEY, checkCompatibility: false })
    : new QdrantClient({ url: "http://127.0.0.1:6333", checkCompatibility: false });
  return _qdrant;
}

/* Robust embedding extraction for v2 */
function extractEmbedding(resp) {
  if (!resp) return null;
  if (resp.embeddings && typeof resp.embeddings === "object") {
    if (Array.isArray(resp.embeddings.float) && resp.embeddings.float.length > 0) return resp.embeddings.float[0];
    if (Array.isArray(resp.embeddings) && resp.embeddings.length > 0) {
      const f = resp.embeddings[0];
      if (Array.isArray(f)) return f;
      if (f && Array.isArray(f.embedding)) return f.embedding;
    }
  }
  if (Array.isArray(resp.embeddings) && resp.embeddings.length > 0) {
    const first = resp.embeddings[0];
    if (Array.isArray(first)) return first;
    if (typeof first === "number") return resp.embeddings;
  }
  if (Array.isArray(resp.data) && resp.data.length > 0) {
    if (Array.isArray(resp.data[0].embedding)) return resp.data[0].embedding;
    if (Array.isArray(resp.data[0].embeddings) && Array.isArray(resp.data[0].embeddings[0])) return resp.data[0].embeddings[0];
  }
  if (resp.body) return extractEmbedding(resp.body);
  return null;
}

export async function embedWithCohere(text) {
  if (!text || !String(text).trim()) throw new Error("embedWithCohere: empty text");
  const c = cfg();
  const client = cohereClient();
  const resp = await client.embed({ model: c.COHERE_MODEL, inputType: "search_query", texts: [text] }, { timeout: c.COHERE_TIMEOUT_MS });
  const emb = resp.embeddings?.float?.[0] ?? resp.embeddings?.[0] ?? resp.data?.[0]?.embedding ?? extractEmbedding(resp);
  if (!emb || !Array.isArray(emb)) throw new Error("Cohere embed returned unexpected shape");
  return emb;
}

export async function qdrantSearch(vector, topK) {
  const c = cfg();
  const client = qdrantClient();
  const resp = await client.search(c.COLLECTION_NAME, { vector, limit: topK, with_payload: true }, { timeout: c.QDRANT_TIMEOUT_MS });

  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.result)) return resp.result;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.hits)) return resp.hits;
  return [];
}

/* simple tokenizer for title match */
function simpleTokens(s) {
  if (!s) return [];
  return String(s).toLowerCase().split(/[\s\W]+/).filter(Boolean);
}
function titleMatchScore(query, title) {
  if (!query || !title) return 0;
  const q = simpleTokens(query);
  const t = new Set(simpleTokens(title));
  if (q.length === 0) return 0;
  let c = 0;
  for (const tok of q) if (t.has(tok)) c++;
  return c / q.length;
}

/* improved safeTruncate: prefer sentence end, else whitespace boundary, else back off a bit */
function safeTruncate(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  // initial cut
  let cut = text.slice(0, maxChars);
  // prefer sentence-ending punctuation followed by space
  const sentenceEndMatch = cut.match(/([.!?])\s(?!.*[.!?]\s)/); // last sentence end in cut
  if (sentenceEndMatch) {
    const idx = cut.lastIndexOf(sentenceEndMatch[1] + " ");
    if (idx > Math.floor(maxChars * 0.3)) {
      return cut.slice(0, idx + 1).trim() + " ...";
    }
  }
  // fallback: cut to last whitespace
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxChars * 0.25)) {
    return cut.slice(0, lastSpace).trim() + " ...";
  }
  // final fallback: back off a bit to avoid broken token (back 8 chars)
  const backoff = Math.max(0, maxChars - 8);
  return text.slice(0, backoff).trim() + " ...";
}

/* payload extraction */
function payloadText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  return (
    payload.text ||
    payload.content ||
    payload.chunk ||
    payload.body ||
    payload.summary ||
    payload.description ||
    payload.article ||
    payload.excerpt ||
    payload.title ||
    ""
  );
}

/* final public function */
export async function getContextWithHits(query, topK = null) {
  const c = cfg();
  topK = topK ?? c.DEFAULT_TOP_K;

  if (!query || !String(query).trim()) return { context: "", hits: [], top_k_used: topK };

  // 1) embed
  let qemb;
  try {
    qemb = await embedWithCohere(query);
  } catch (e) {
    return { context: "", hits: [], top_k_used: topK, error: `Cohere embed failed: ${e?.message || e}` };
  }

  // 2) qdrant search
  let rawHits;
  try {
    rawHits = await qdrantSearch(qemb, topK);
  } catch (e) {
    return { context: "", hits: [], top_k_used: topK, error: `Qdrant search failed: ${e?.message || e}` };
  }

  // 3) normalize
  const normalized = (rawHits || []).map((h) => ({
    id: h.id ?? h._id ?? null,
    score: typeof h.score === "number" ? h.score : (h.payload_score ?? null),
    payload: h.payload ?? h,
  }));

  // 4) lightweight rescoring by title match
  const alpha = c.TITLE_BOOST_ALPHA;
  const rescored = normalized.map((h) => {
    const title = (h.payload && (h.payload.title || h.payload.headline || h.payload.name)) || "";
    const match = titleMatchScore(query, title);
    const newScore = (h.score ?? 0) + alpha * match;
    return { ...h, score: newScore, _title_match: match };
  });

  // 5) dedupe by source/title keep highest score
  const consider = rescored.slice(0, c.MAX_HITS_TO_CONSIDER);
  const map = new Map();
  for (const h of consider) {
    const p = h.payload || {};
    const key = (p.url || p.source || p.link || p.title || h.id || "").toString().trim();
    if (!key) {
      const idKey = `__id__:${h.id ?? Math.random().toString(36).slice(2,8)}`;
      if (!map.has(idKey)) map.set(idKey, h);
      else if ((h.score ?? 0) > (map.get(idKey).score ?? 0)) map.set(idKey, h);
      continue;
    }
    if (!map.has(key)) map.set(key, h);
    else if ((h.score ?? 0) > (map.get(key).score ?? 0)) map.set(key, h);
  }

  // 6) sort by score desc
  let deduped = Array.from(map.values());
  deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // 7) build context pieces with deduped top hits and safe truncation
  const pieces = [];
  let chars = 0;
  for (let i = 0; i < Math.min(deduped.length, c.MAX_HITS_IN_CONTEXT); i++) {
    const h = deduped[i];
    const p = h.payload || {};
    const title = p.title ? String(p.title).trim() : "";
    let snippet = String(payloadText(p) || "").trim();

    // Avoid repeating the title in the snippet if snippet starts with title text
    if (title && snippet) {
      const snippetLower = snippet.toLowerCase();
      const titleLower = title.toLowerCase();
      if (snippetLower.startsWith(titleLower)) {
        // remove leading title from snippet (plus any punctuation/newline)
        snippet = snippet.slice(title.length).replace(/^[\s:–—\-]+/, "").trim();
      }
    }

    // Ensure Source appears on its own line
    const sourceLine = p.url ? `\nSource: ${p.url}` : p.source ? `\nSource: ${p.source}` : "";

    const pieceBase = title ? `${title}\n` : "";
    const fullPiece = (pieceBase + snippet + sourceLine).trim();
    if (!fullPiece) continue;

    const remaining = c.MAX_CONTEXT_CHARS - chars;
    if (remaining <= 80) break; // safety margin
    if (fullPiece.length <= remaining) {
      pieces.push(fullPiece);
      chars += fullPiece.length + 2;
    } else {
      const safe = safeTruncate(fullPiece, Math.max(80, remaining - 3));
      pieces.push(safe);
      chars += safe.length + 2;
      break;
    }
  }

  const context = pieces.join("\n\n");

  // 8) mapped hits
  const mappedHits = deduped.map((h) => {
    const p = h.payload || {};
    return {
      id: h.id,
      score: h.score,
      payload: {
        ...p,
        source: p.url || p.source || p.link || p.title || null,
        _title_match: h._title_match ?? 0,
      },
    };
  });

  return { context, hits: mappedHits, top_k_used: topK };
}
