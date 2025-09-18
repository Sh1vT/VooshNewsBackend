# Voosh News RAG Backend (Node.js)

This project is live at [Vercel](https://voosh-news-frontend.vercel.app/)

A Retrieval-Augmented Generation (RAG) backend for a news Q&A chatbot. It embeds queries with Jina Embeddings, retrieves top-k passages from Qdrant, and asks Google Gemini to produce final answers. Per-session chat history is cached in Redis.

### Table of Contents
- Overview
- Architecture
- Tech Stack
- Directory Structure
- Getting Started
  - Prerequisites
  - Environment Variables
  - Installation
  - Running Locally
- API Reference
  - Session
  - Chat
  - Featured (Top-K)
  - Health
- RAG Pipeline Details
  - Embeddings
  - Vector Search (Qdrant)
  - Generation (Gemini)
- Caching & Performance
  - Redis Keys, TTLs, Warming
- Data Ingestion (Indexing News)
- Design Decisions
- Troubleshooting
- Deployment Notes
- Deliverables Checklist Mapping

## Overview
This backend powers a simple chatbot that answers queries over a news corpus using a RAG pipeline:
- Embed the incoming query with Jina.
- Retrieve semantically similar passages from Qdrant.
- Construct a concise context and ask Gemini for the final answer.
- Maintain per-session chat history in Redis.

The repository is designed to serve as the backend half of the assignment. A separate frontend (React + SCSS) should consume these APIs.

## Architecture
- `Express` web server exposes REST endpoints.
- `services/ragService.js` handles embeddings and vector search.
- `services/geminiService.js` wraps Gemini client and normalizes responses.
- `services/redisService.js` stores chat history per session and orchestrates the end-to-end RAG + LLM call for each message.

Data flow per user query:
1) Client sends `POST /chat/:sessionId` with `{ query }`.
2) Backend embeds query (Jina) → searches Qdrant → builds `context`.
3) Backend asks Gemini with `(query, context)` → gets `answer`.
4) `{ query, answer, context_summary, timestamp }` is appended to Redis list for the session.

## Tech Stack
- Backend: Node.js (Express)
- Embeddings: Jina Embeddings (HTTP API)
- Vector DB: Qdrant (REST API)
- LLM: Google Gemini (`@google/generative-ai`)
- Cache & Sessions: Redis (ioredis)

## Directory Structure
```
server.js
package.json
/services
  ├─ geminiService.js
  ├─ ragService.js
  └─ redisService.js
/routes
  ├─ chatRoutes.js
  ├─ featured.js
  └─ sessionRoutes.js
/tools
```

## Getting Started

### Prerequisites
- Node.js 18+ (for global `fetch`)
- Redis instance (local or managed)
- Qdrant instance with your news vectors indexed
- API keys: Jina (embeddings) and Google Gemini

### Environment Variables
Create a `.env` file at the project root:
```
PORT=5000

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite

# Jina Embeddings
JINA_API_KEY=your_jina_api_key
JINA_MODEL=jina-embeddings-v2-base-en

# Qdrant
QDRANT_HOST=your_qdrant_host_url
QDRANT_API_KEY=your_qdrant_api_key
COLLECTION_NAME=voosh_news_v1

# Redis
REDIS_URL=redis://localhost:6379 (or swap with Redis Cloud)

# Retrieval
DEFAULT_TOP_K=5
```
Notes:
- `QDRANT_HOST` is required at boot; the app will throw if missing.
- `REDIS_URL` can be plain `redis://` or TLS `rediss://`.
- `DEFAULT_TOP_K` controls the default number of passages retrieved per query. The service may retry with a higher `top_k` if initial context looks weak.

### Installation
```
npm install
```

### Running Locally
- Dev (auto-reload):
```
npm run dev
```
- Prod:
```
npm start
```
Server logs will show `.env` resolution and port binding.

## API Reference
Base URL when running locally: `http://localhost:5000`

Important: In `server.js`, routes are currently mounted without `/api` prefix.

### Session
- Create a new session ID
  - Method: `POST`
  - Path: `/session`  ← note: typo in mount (should be `/session`)
  - Response:
```
{ "sessionId": "uuid-v4" }
```

### Chat
- Send a user query in an existing session
  - Method: `POST`
  - Path: `/chat/:sessionId`
  - Body:
```
{ "query": "What happened in markets today?" }
```
  - Success Response (normalized):
```
{
  "sessionId": "...",
  "query": "...",
  "answer": "...",
  "context": "concatenated passages...",
  "hits": [ { "id": "...", "score": 0.42, "payload": { /* your stored fields */ } }, ... ],
  "top_k_used": 5
}
```
  - In cases where only a string answer is returned internally, the route normalizes it to `{ answer: "..." }`.

- Get session history
  - Method: `GET`
  - Path: `/chat/:sessionId`
  - Response:
```
{
  "sessionId": "...",
  "history": [
    { "query": "...", "answer": "...", "context_summary": "...", "timestamp": 1712345678 },
    ...
  ]
}
```

- Clear session history
  - Method: `DELETE`
  - Path: `/chat/:sessionId`
  - Response:
```
{ "sessionId": "...", "cleared": true }
```

### Featured (Top-K)
- Retrieve a curated list of top-k relevant items for a query
  - Method: `GET`
  - Path: `/featured`
  - Query Params:
    - `q`: string, default `latest news`
    - `k`: number, default `3`, clamped to [1, 20]
  - Response:
```
{
  "ok": true,
  "featured": [
    { "id": "...", "score": 0.42, "headline": "...", "excerpt": "...", "source": "...", "published": "..." },
    ...
  ],
  "raw": { "context": "...", "hits": [ ... ], "top_k_used": 5 }
}
```

### Health
- Method: `GET`
- Path: `/health`
- Response:
```
{ "status": "ok", "service": "Node Backend" }
```

## RAG Pipeline Details

### Embeddings (Jina)
- File: `services/ragService.js`
- Endpoint: `POST https://api.jina.ai/v1/embeddings`
- Body shape: `{ model, input: [text] }`
- Response shape handled: `{ data: [{ embedding: [...] }, ...] }`
- Env: `JINA_API_KEY`, `JINA_MODEL`

### Vector Search (Qdrant)
- File: `services/ragService.js`
- Endpoint: `POST {QDRANT_HOST}/collections/{COLLECTION_NAME}/points/search`
- Body shape: `{ vector, limit, with_payload: true, with_vector: false }`
- Response normalized to: `[{ id, score, payload }, ...]`
- Env: `QDRANT_HOST` (required), `QDRANT_API_KEY`, `COLLECTION_NAME`

### Generation (Gemini)
- File: `services/geminiService.js`
- Client: `@google/generative-ai`
- The wrapper tries multiple call signatures and extracts text robustly from different response shapes.
- Prompt template:
  - "Answer the following query using ONLY the context provided. Include sources."
- Env: `GEMINI_API_KEY`, optional `GEMINI_MODEL`

## Caching & Performance

### Redis Keys
- Per-session list key: `chat:<sessionId>`
- Each list item is a JSON string of `{ query, answer, context_summary, timestamp }`.

### TTLs
- `services/redisService.js` uses `expire(key, ttlSeconds)` on every append.
- Default TTL is 30 days (2,592,000 seconds). Code location: `safeAppendChat`.
- To change TTLs, adjust the `ttlSeconds` argument in `safeAppendChat`, or introduce an env variable and pass it through.

### Cache Warming
- Optionally, pre-fetch featured results on startup for popular queries and push them into Redis, or run a background job that queries `/featured?q=<topic>&k=3` for a curated set of topics to keep hot. This implementation has been used on the mentioned frontend as a `bonus feature`
- You can also warm Qdrant caches by issuing a few representative queries at boot.

## Data Ingestion (Indexing News)
This repo focuses on query-time RAG. You must index your ~50 articles into Qdrant ahead of time. A typical ingestion script should:
1) Collect articles (RSS/HTML). For reference: `news-please` (Python) or Reuters sitemaps.
2) For each article, produce a payload with fields like:
```
{
  id: "unique-id",
  text: "full passage or chunk",
  title: "headline",
  url: "https://...",
  published: "2025-09-01T12:00:00Z"
}
```
3) Compute embeddings for each chunk (Jina or your chosen embedding model) and upsert into Qdrant collection `COLLECTION_NAME` with the payload above.

References:
- Jina Embeddings: `https://jina.ai/embeddings`
- Qdrant Quickstart: `https://qdrant.tech/documentation/quickstart/`

## Design Decisions
- Stateless app servers with Redis for session history to allow horizontal scaling.
- Robust Gemini wrapper that tolerates SDK response shape changes and logs extraction issues.
- Retrieval retry: if initial context doesn’t seem to include query tokens, retry with higher `top_k` up to 20.
- Context size capped to keep prompts within model limits.

## Troubleshooting
- Qdrant host is required. The server will throw on startup if `QDRANT_HOST` is missing.
- If Redis is not configured, the app will still run and log that Redis is uninitialized. History endpoints will return empty and writes will no-op.
- Node version: ensure Node 18+ for global `fetch`; otherwise add `node-fetch` and adapt `ragService.js`.

## Deployment Notes
- Suggested free/low-cost options:
  - Backend: Render(used), Railway, Fly.io
  - Qdrant: Qdrant Cloud (free tier, used) or self-host
  - Redis: Upstash, Redis Cloud (used)
- Ensure you set all env vars in the hosting provider dashboard.

## Deliverables Checklist Mapping
- List of tech stack used: see Tech Stack section.
- Two repos: this is the backend. Create a separate frontend (React + SCSS) that calls these APIs.
- Demo video: show starting backend, querying `/chat/:sessionId`, reading and clearing history, and `/featured` examples.
- Code walkthrough: explain ingestion, Qdrant schema, retrieval flow (`ragService.js`), Redis history (`redisService.js`), and Gemini prompt (`geminiService.js`).
- Live deployment: host the backend and share the public URL. Ensure CORS allows your frontend origin.

---

If you need a minimal frontend, build a React client with:
- A chat screen tied to `sessionId` from `POST /session`
- Send messages to `POST /chat/:sessionId`
- Stream or type-out the `answer` response
- Show history from `GET /chat/:sessionId`
- Reset with `DELETE /chat/:sessionId` 