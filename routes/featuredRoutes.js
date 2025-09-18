import express from "express";
import { fetchFeatured } from "../services/featuredService.js";


const router = express.Router();


router.get("/", async (req, res) => {
    console.log("[/featured] hit with query:", req.query);
    const q = (req.query.q || "latest news").toString();
    const k = Math.max(1, Math.min(20, parseInt(req.query.k || "3", 10)));


    console.log(`[featured route] incoming request, q=${q}, k=${k}`);
    try {
        const { featured, raw, meta } = await fetchFeatured(q, k);
        console.log(`[featured route] fetchFeatured finished in ${meta.elapsed}ms, hits=${meta.hitsCount}`);
        return res.json({ ok: true, featured, raw });
    } catch (err) {
        console.error("[featured route] error:", err);
        return res.status(500).json({ ok: false, error: String(err) });
    }
});


export default router;