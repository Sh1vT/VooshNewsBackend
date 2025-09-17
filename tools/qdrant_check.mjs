// qdrant_check.mjs
import { QdrantClient } from "@qdrant/js-client-rest";

const host = process.env.QDRANT_HOST;
const key = process.env.QDRANT_API_KEY || undefined;
const col = process.env.COLLECTION_NAME || "voosh_news_v1";

const client = host ? new QdrantClient({ url: host, apiKey: key }) : new QdrantClient({ url: "http://127.0.0.1:6333" });

(async () => {
  try {
    const cols = await client.getCollections();
    console.log("Collections:", cols?.collections ?? cols);
    // Try get collection info
    try {
      const info = await client.getCollection(col);
      console.log(`Collection "${col}" info:`, info);
    } catch (err) {
      console.warn(`Could not fetch collection info for "${col}":`, err?.message ?? err);
    }

    // Try count points (if supported)
    try {
      const count = await client.count(col);
      console.log(`Point count in "${col}":`, count);
    } catch (err) {
      console.warn("Count not available:", err?.message ?? err);
    }
  } catch (e) {
    console.error("Qdrant list error:", e?.message ?? e);
  }
})();
