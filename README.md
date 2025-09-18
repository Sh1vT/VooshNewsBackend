# Voosh News — RAG Backend (Node.js/Express)

Live Frontend: [voosh-news-frontend.vercel.app](https://voosh-news-frontend.vercel.app/)

A lightweight REST backend for a Retrieval-Augmented Generation (RAG) chatbot on news articles. It embeds queries with Jina, retrieves from Qdrant, and calls Gemini to generate answers. Each session has isolated history stored in Redis with TTL.

---

## Features
- REST endpoints for session, chat, history, featured stories, and health
- Jina embeddings + Qdrant vector search
- Gemini answer synthesis with citations (from payload URLs)
- Redis-backed session history with TTL and easy reset

---

## Architecture
1) Client sends `query` with a `sessionId`
2) Backend embeds query (Jina) and retrieves top-k passages from Qdrant
3) A trimmed context is built from retrieved payloads
4) Gemini generates the final answer from the context
5) `{query, answer, context_summary, timestamp}` is appended to Redis list `chat:<sessionId>`

---

## Tech Stack
- Backend: Node.js + Express
- Embeddings: Jina AI (HTTP API)
- Vector DB: Qdrant (REST)
- LLM: Google Gemini (`@google/generative-ai`)
- Cache: Redis (ioredis)

---

## API Endpoints
- `GET /health` → `{ status: "ok" }`
- `GET /featured?q=...&k=...` → returns curated top-k items built from Qdrant hits
- `POST /session` → `{ sessionId }`
- `GET /chat/:sessionId` → returns session history (Redis list)
- `POST /chat/:sessionId` with `{ query }` → `{ answer, context, hits, top_k_used }`
- `DELETE /chat/:sessionId` → clears session history

Note: Routes are mounted at root (no `/api` prefix). If you prefer `/api`, update `server.js` mounts accordingly.

---

## Getting Started
### Prerequisites
- Node.js 18+
- Redis instance (local or managed)
- Qdrant collection populated with your news vectors
- API keys for Jina and Gemini

### Setup
1) Create `.env` in project root:
```
PORT=5000

# Gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite

# Jina Embeddings
JINA_API_KEY=your_jina_api_key
JINA_MODEL=jina-embeddings-v2-base-en

# Qdrant
QDRANT_HOST=https://your-qdrant-host:6333 (or_qdrant_cloud_url)
QDRANT_API_KEY=your_qdrant_api_key
COLLECTION_NAME=voosh_news_v1

# Redis
REDIS_URL=redis://localhost:6379 (or_redis_cloud_url)

# Retrieval
DEFAULT_TOP_K=5
```
2) Install and run:
```
npm install
npm run dev    # or: npm start
```
The server starts on `http://localhost:5000`.

---

## Project Structure
```
server.js
/services
  geminiService.js     # robust Gemini wrapper
  ragService.js        # Jina embeddings + Qdrant search + context builder
  redisService.js      # session storage + RAG orchestration for /chat
/routes
  chatRoutes.js        # chat + history + clear
  featured.js          # featured items from top-k hits
  sessionRoutes.js     # create session (uuid)
```

---

## How It Works (Assessment Notes)
- Embeddings creation/indexing/storage
  - Ingestion (external script): scrape or load ~50 news articles, chunk text, embed each chunk with Jina, upsert to Qdrant with payload fields (e.g., `text`, `title`, `url`, `published`).
  - Query-time: `ragService.getContextWithHits(query, top_k)` calls Jina `POST /v1/embeddings`, then Qdrant `/collections/{collection}/points/search`, normalizes hits, and concatenates a trimmed context from payload fields.
- Redis caching & session history
  - Each session uses key `chat:<sessionId>` (Redis list). On every message, `{ query, answer, context_summary, timestamp }` is appended.
  - A TTL is set on the list key (default 30 days). Change in `safeAppendChat(..., ttlSeconds)` or wire via env.
  - `GET /chat/:sessionId` reads the entire list; `DELETE /chat/:sessionId` removes it.
- API flow from frontend
  - Frontend obtains `sessionId` via `POST /session`
  - Sends user text via `POST /chat/:sessionId` → receives `{ answer, context, hits }`
  - Renders markdown answer with citation pills using `payload.url` from hits; shows featured via `GET /featured`
- Design decisions & improvements
  - Stateless app with Redis for history enables horizontal scale
  - Retry retrieval with higher `top_k` if initial context seems weak
  - Context length capped to avoid model overflow
  - Improvements: server-sent events for streaming, per-user rate limiting, stronger payload schema, observability (timings, hit diagnostics), configurable TTL via env

---

## Caching & Performance
- Default TTL: 30 days on `chat:<sessionId>` keys
- To change TTL: edit `services/redisService.js` `safeAppendChat` or introduce `CHAT_TTL_SECONDS` env and pass it through
- Cache warming suggestions: pre-hit `/featured` for common topics; issue representative searches at boot to warm Qdrant

---

## Deployment
- Works on Render, Railway, Fly.io, etc.
- Ensure all env vars are set (Gemini, Jina, Qdrant, Redis)
- If exposing publicly, restrict origins in `cors()`

---

## Troubleshooting
- Server throws on start: ensure `QDRANT_HOST` is set
- Empty history: likely `REDIS_URL` not configured; writes no-op when Redis is missing
- Node < 18: add `node-fetch` and adapt `ragService.js`
