// server.js
import path from "path";
import dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env");
console.log("[dotenv] attempting to load .env from:", envPath);
dotenv.config();

import express from "express";
import cors from "cors";
import chatRoutes from "./routes/chatRoutes.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import featuredRoute from "./routes/featured.js";

const app = express();

app.use(cors());
app.use(express.json());

// mount existing chat/session routes under /api to match frontend API_BASE_URL = "/api"
app.use("/chat", chatRoutes);
app.use("/session", sessionRoutes);

// add featured endpoint at /api/featured
app.use("/featured", featuredRoute);

// keep a simple health endpoint (non-prefixed)
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Node Backend" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Node backend running on port ${PORT}`);
});
