// // services/geminiService.js
// import { GoogleGenerativeAI } from "@google/generative-ai";

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // match Python

// export async function askGemini(query, context) {
//   const prompt = `Answer the following query using ONLY the context provided. Include sources.\n\nContext:\n${context}\n\nQuestion: ${query}`;

//   console.log("[GEMINI] prompt length:", prompt.length);
//   console.log("[GEMINI] prompt preview:", (prompt || "").slice(0, 1200));

//   try {
//     // adapt to your installed library shape:
//     const result = await model.generateContent(prompt);

//     // Many client versions: result.response.text , or result.text
//     if (result?.response?.text) return result.response.text;
//     if (result?.text) return result.text;

//     // fallback: stringify the entire response
//     return JSON.stringify(result);
//   } catch (err) {
//     console.error("[GEMINI] error:", err);
//     return "Sorry, I couldn't generate a response.";
//   }
// }

// services/geminiService.js
// Robust Gemini wrapper: tries additional call signatures, streaming shapes,
// and logs raw response automatically when extraction fails.



import { GoogleGenerativeAI } from "@google/generative-ai";

let genAI = null;
let model = null;

function initClient() {
  if (model) return model;
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite" });
  return model;
}

function safeStringify(o, max = 20000) {
  try {
    const s = JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    return s.length > max ? s.slice(0, max) + `... (truncated ${s.length - max} chars)` : s;
  } catch (e) {
    try {
      const s = String(o);
      return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
    } catch {
      return "<unserializable>";
    }
  }
}

/** Try to extract human text from many possible response shapes */
function extractTextFromResponse(res) {
  if (!res) return null;

  if (res.response) {
    if (typeof res.response.text === "string" && res.response.text.trim()) return res.response.text;
    if (typeof res.response.message === "string" && res.response.message.trim()) return res.response.message;
    if (Array.isArray(res.response.candidates) && res.response.candidates.length > 0) {
      const c = res.response.candidates[0];
      if (typeof c.content === "string" && c.content.trim()) return c.content;
      if (typeof c.message === "string" && c.message.trim()) return c.message;
      if (typeof c.output === "string" && c.output.trim()) return c.output;
      if (c.output && Array.isArray(c.output) && typeof c.output[0]?.content === "string" && c.output[0].content.trim()) {
        return c.output[0].content;
      }
    }
  }

  if (typeof res.text === "string" && res.text.trim()) return res.text;
  if (typeof res.output === "string" && res.output.trim()) return res.output;

  if (Array.isArray(res.candidates) && res.candidates.length > 0) {
    const cand = res.candidates[0];
    if (typeof cand.content === "string" && cand.content.trim()) return cand.content;
    if (typeof cand.message?.content === "string" && cand.message.content.trim()) return cand.message.content;
    if (typeof cand.text === "string" && cand.text.trim()) return cand.text;
  }

  if (Array.isArray(res.answers) && res.answers.length > 0 && typeof res.answers[0].text === "string") return res.answers[0].text;
  if (Array.isArray(res.outputs) && res.outputs.length > 0) {
    if (typeof res.outputs[0].content === "string" && res.outputs[0].content.trim()) return res.outputs[0].content;
    if (typeof res.outputs[0].text === "string" && res.outputs[0].text.trim()) return res.outputs[0].text;
  }

  const searchPaths = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    for (const k of Object.keys(obj)) {
      try {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v;
        if (Array.isArray(v)) {
          for (const item of v) {
            if (!item) continue;
            if (typeof item === "string" && item.trim()) return item;
            if (typeof item.content === "string" && item.content.trim()) return item.content;
            if (typeof item.text === "string" && item.text.trim()) return item.text;
            if (item.message && typeof item.message.content === "string" && item.message.content.trim()) return item.message.content;
            if (Array.isArray(item.candidates) && item.candidates[0] && typeof item.candidates[0].content === "string")
              return item.candidates[0].content;
          }
        }
        if (typeof v === "object") {
          const nested = searchPaths(v);
          if (nested) return nested;
        }
      } catch (e) {
        // ignore
      }
    }
    return null;
  };

  const found = searchPaths(res);
  if (found && typeof found === "string" && found.trim()) return found;

  return null;
}

/** Try many likely call signatures for different SDK versions */
async function callModelWithManySignatures(model, prompt) {
  const calls = [
    async () => typeof model.generateContent === "function" ? await model.generateContent(prompt) : null,
    async () => typeof model.generateContent === "function" ? await model.generateContent({ input: prompt }) : null,
    async () => typeof model.generateContent === "function" ? await model.generateContent({ prompt: prompt }) : null,
    async () => typeof model.generate === "function" ? await model.generate(prompt) : null,
    async () => typeof model.generate === "function" ? await model.generate({ prompt }) : null,
    async () => typeof model.generate === "function" ? await model.generate({ input: prompt }) : null,
    async () => typeof model.generateText === "function" ? await model.generateText(prompt) : null,
    async () => typeof model.generateText === "function" ? await model.generateText({ prompt }) : null,
    async () => typeof model.chat === "function" ? await model.chat([{ role: "user", content: prompt }]) : null,
    async () => typeof model.chat === "function" ? await model.chat({ messages: [{ role: "user", content: prompt }] }) : null,
    async () => typeof model.generate === "function" ? await model.generate({ instances: [{ input: prompt }] }) : null,
  ];

  for (const fn of calls) {
    try {
      const r = await fn();
      if (r != null) return r;
    } catch (e) {
      console.warn("[GEMINI] model method attempt failed:", e?.message ?? e);
    }
  }

  return null;
}

/**
 * askGemini(query, context, options)
 * options.debug = true  -> prints full prompt and extracted text to console and returns an object { prompt, text, raw }
 * otherwise returns extracted text (or JSON fallback / error string)
 */
export async function askGemini(query, context, options = {}) {
  const debug = options.debug === true;
  const model = initClient();
  const prompt = `Answer the following query using ONLY the context provided. Include sources.\n\nContext:\n${context}\n\nQuestion: ${query}`;

  // console.log("[GEMINI] prompt length:", prompt.length);
  // console.log("[GEMINI] prompt preview:", (prompt || "").slice(0, 1200));

  try {
    const raw = await callModelWithManySignatures(model, prompt);

    if (raw == null) {
      const msg = "[GEMINI] no supported model method returned a value (checked many signatures)";
      console.error(msg);
      if (debug) {
        // console.log("FULL PROMPT (debug):\n", prompt);
        // console.log("RAW MODEL RESPONSE: null");
        return { error: msg, prompt, raw: null };
      }
      return "Sorry — the model client did not return a response (no supported method).";
    }

    const text = extractTextFromResponse(raw);
    // console.log("[GEMINI] extracted response length:", text ? text.length : 0);

    if (text) {
      // console.log("========= GEMINI RESPONSE =========\n", text, "\n==================================");
    }

    if (debug) {
      // print full prompt and the extracted text (or raw fallback)
      // console.log("========== GEMINI DEBUG OUTPUT ==========");
      // console.log("FULL PROMPT SENT TO GEMINI:\n", prompt);
      if (text && text.trim()) {
        // console.log("\nEXTRACTED TEXT RESPONSE:\n", text);
      } else {
        // console.log("\nCOULD NOT EXTRACT TEXT - RAW RESPONSE FOLLOWS:\n", safeStringify(raw, 200000));
      }
      // console.log("=========================================");
      return { prompt, text: text ?? null, raw };
    }

    if (text && text.trim().length > 0) return text;

    console.error("[GEMINI] unable to extract text; raw response follows (full):");
    console.error(safeStringify(raw, 200000));

    return safeStringify(raw, 16000);
  } catch (err) {
    console.error("[GEMINI] call error:", err?.response ?? err?.message ?? err);
    if (debug) {
      // console.log("FULL PROMPT (debug):\n", prompt);
      return { error: "internal error", err: String(err), prompt };
    }
    return "Sorry, I couldn't generate a response due to an internal error.";
  }
}

/*
==========================
Quick test / usage example
(UNCOMMENT to run locally for a one-off test)

(async () => {
  const question = "Summarize the context and answer briefly.";
  const context = "Short context goes here. Replace with your RAG passages.";
  const result = await askGemini(question, context, { debug: true });
  // result contains { prompt, text, raw } and has already been printed to console.
})();
==========================
*/
