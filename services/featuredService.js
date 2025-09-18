// services/featuredService.js
import { getContextWithHits } from "../services/ragService.js";


// server-side safe truncate (kept in service so route stays thin)
export function safeTruncate(text, maxChars = 200) {
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
* Fetches context/hits using ragService and normalizes a featured array.
* Returns: { featured: Array, raw: <original response>, meta: { elapsed, hitsCount, top_k_used } }
*/
export async function fetchFeatured(q = "latest news", k = 3) {
    const start = Date.now();
    const response = await getContextWithHits(q, k);
    const elapsed = Date.now() - start;


    const hits = Array.isArray(response.hits) ? response.hits : [];


    if (hits.length > 0) {
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


        return { featured, raw: response, meta: { elapsed, hitsCount: hits.length, top_k_used: response.top_k_used ?? null } };
    }


    // fallback: use response.context if available
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
        return { featured: fallback, raw: response, meta: { elapsed, hitsCount: 0, top_k_used: response.top_k_used ?? null } };
    }


    return { featured: [], raw: response, meta: { elapsed, hitsCount: 0, top_k_used: response.top_k_used ?? null } };
}