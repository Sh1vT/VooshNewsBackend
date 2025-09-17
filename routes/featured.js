// backend/routes/featured.js
import express from "express";
import { getContextWithHits } from "../services/ragService.js";

const router = express.Router();

// server-side safe truncate (reuse ragService style, kept local here)
function safeTruncate(text, maxChars = 200) {
  if (!text) return "";
  text = String(text);
  if (text.length <= maxChars) return text;

  let cut = text.slice(0, maxChars);

  // Prefer sentence-ending punctuation near the end
  const sentenceEnd = cut.match(/([.!?])\s(?!.*[.!?]\s)/);
  if (sentenceEnd) {
    const idx = cut.lastIndexOf(sentenceEnd[1] + " ");
    if (idx > Math.floor(maxChars * 0.3)) {
      return cut.slice(0, idx + 1).trim();
    }
  }

  // Otherwise cut at last space
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxChars * 0.25)) {
    return cut.slice(0, lastSpace).trim() + " …";
  }

  // Fallback: chop a few chars earlier to avoid mid-word cutoff
  return cut.slice(0, Math.max(0, maxChars - 5)).trim() + " …";
}

/**
 * GET /featured
 * Query params:
 *   q - optional query text (default "latest news")
 *   k - optional top-k number (default 3)
 *
 * Returns:
 *   { ok: true, featured: [ { id, score, headline, excerpt, source, published }, ... ], raw }
 */
router.get("/", async (req, res) => {
  console.log("[/featured] hit with query:", req.query);
  const q = (req.query.q || "latest news").toString();
  const k = Math.max(1, Math.min(20, parseInt(req.query.k || "3", 10))); // clamp between 1 and 20

  console.log(`[featured] incoming request, q=${q}, k=${k}`);

  try {
    const start = Date.now();
    // ask the RAG service for top-k context/hits
    const response = await getContextWithHits(q, k);
    const elapsed = Date.now() - start;
    console.log(`[featured] ragService.getContextWithHits finished in ${elapsed}ms`);
    console.log("[featured] received response summary:", {
      contextLength: (response.context || "").length,
      hitsCount: Array.isArray(response.hits) ? response.hits.length : 0,
      error: response.error ?? null,
      top_k_used: response.top_k_used ?? null,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];

    if (hits.length > 0) {
      // Normalize top-k hits into featured array (up to k, dedup already done in service)
      const featured = hits.slice(0, k).map((top) => {
        const payload = top.payload || {};
        const headline = (payload.title || payload.headline || payload.name || "").toString().trim();
        const rawExcerpt = (payload.text || payload.excerpt || payload.description || "").toString().trim();
        const excerpt = safeTruncate(rawExcerpt, 200);
        return {
          id: top.id ?? null,
          score: top.score ?? null,
          headline,
          excerpt,
          source: payload.url || payload.source || payload.link || null,
          published: payload.published || payload.date || null,
        };
      });

      console.log("[featured] returning featured array length:", featured.length);
      return res.json({ ok: true, featured, raw: response });
    }

    // fallback: return context as single item if available
    if (response.context && response.context.trim()) {
      const excerpt = safeTruncate(response.context.replace(/\n+/g, " "), 200);
      const fallback = [
        {
          id: null,
          score: null,
          headline: "Top stories",
          excerpt,
          source: "VooshNews",
          published: null,
        },
      ];
      return res.json({ ok: true, featured: fallback, raw: response });
    }

    // nothing to return
    return res.json({ ok: true, featured: [], raw: response });
  } catch (err) {
    console.error("[featured] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
