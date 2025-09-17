// routes/chatRoutes.js
import express from "express";
import { handleChat, getHistory, clearHistory } from "../services/redisService.js";

const router = express.Router();

/**
 * POST /chat/:sessionId
 * -> Ask a question in a session, get Gemini’s answer, save to Redis
 *
 * This handler accepts two shapes returned by handleChat:
 * 1) a plain string answer
 * 2) a rich object { answer, context, hits, top_k_used }
 *
 * We normalize both and return a consistent JSON response.
 */
router.post("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const result = await handleChat(sessionId, query);

    // If handleChat returned an object with "answer", spread it
    if (result && typeof result === "object" && result.answer !== undefined) {
      return res.json({ sessionId, query, ...result });
    }

    // Otherwise assume it's a plain answer string
    return res.json({ sessionId, query, answer: result });
  } catch (err) {
    console.error("POST /chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chat/:sessionId
 * -> Retrieve chat history for a session
 */
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const history = await getHistory(sessionId);
    res.json({ sessionId, history });
  } catch (err) {
    console.error("GET /chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /chat/:sessionId
 * -> Clear chat history for a session
 */
router.delete("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    await clearHistory(sessionId);
    res.json({ sessionId, cleared: true });
  } catch (err) {
    console.error("DELETE /chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
