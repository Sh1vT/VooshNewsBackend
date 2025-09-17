// cohere_test.mjs
import { CohereClientV2 } from "cohere-ai";

const co = new CohereClientV2({ token: process.env.CO_API_KEY || process.env.COHERE_API_KEY });

(async () => {
  try {
    const text = "give me some sports news?";
    const r = await co.embed({ model: process.env.COHERE_MODEL || "embed-english-light-v3.0", inputType: "search_query", texts: [text] });
    // extract embedding from v2 shape
    const emb = r.embeddings?.float?.[0] ?? r.embeddings?.[0] ?? r.data?.[0]?.embedding ?? null;
    console.log("Embedding exists:", Boolean(emb));
    console.log("Embedding length:", emb?.length);
    console.log("Embedding sample (first 10):", Array.isArray(emb) ? emb.slice(0,10) : emb);
  } catch (e) {
    console.error("Embed error:", e?.response?.data ?? e?.message ?? e);
  }
})();
