/**
 * HITL-CDT API Gateway — port 4000
 *
 * Routes:
 *   /api/predict/*, /api/explain/*, /api/model/*  → ML Service  :8001
 *   /api/twin/*                                   → Twin Service :8002
 *   /api/decisions/*, /api/experiment/*,
 *   /api/config/*                                 → Decision Service :8003
 *
 * WebSocket: broadcasts twin state to all connected clients every 5 seconds.
 */

const express = require("express");
const http    = require("http");
const cors    = require("cors");
const { Server }           = require("socket.io");
const { createProxyMiddleware } = require("http-proxy-middleware");

// --------------------------------------------------------------------------
// App + HTTP server (Socket.io needs the raw http.Server, not just express)
// --------------------------------------------------------------------------
const app    = express();
const server = http.createServer(app);

// --------------------------------------------------------------------------
// CORS — allow the React dev server (and same origin in production)
// --------------------------------------------------------------------------
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:4000"] }));

// --------------------------------------------------------------------------
// Proxy helper — strips the /api prefix before forwarding
// --------------------------------------------------------------------------
function proxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // /api/predict/batch  →  /predict/batch
    pathRewrite: { "^/api": "" },
  });
}

// --------------------------------------------------------------------------
// Route → service mapping
// --------------------------------------------------------------------------
app.use("/api/predict",    proxy("http://localhost:8001"));
app.use("/api/explain",    proxy("http://localhost:8001"));
app.use("/api/model",      proxy("http://localhost:8001"));

app.use("/api/twin",       proxy("http://localhost:8002"));

app.use("/api/decisions",  proxy("http://localhost:8003"));
app.use("/api/experiment", proxy("http://localhost:8003"));
app.use("/api/config",     proxy("http://localhost:8003"));

// --------------------------------------------------------------------------
// Simple health check for the gateway itself
// --------------------------------------------------------------------------
app.get("/health", (_req, res) =>
  res.json({ status: "ok", gateway: "hitl-cdt", port: 4000 })
);

// --------------------------------------------------------------------------
// Socket.io
// --------------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: ["http://localhost:5173", "http://localhost:4000"] },
});

io.on("connection", (socket) => {
  console.log(`[ws] client connected  (${socket.id})`);
  socket.on("disconnect", () =>
    console.log(`[ws] client disconnected (${socket.id})`)
  );
});

// --------------------------------------------------------------------------
// Polling loop — fetch twin state every 5 s, broadcast to all WS clients
// --------------------------------------------------------------------------
async function pollTwinState() {
  try {
    const res  = await fetch("http://localhost:8002/state");
    const data = await res.json();
    io.emit("twin:state_update", data);
  } catch {
    // Twin service may not be running yet — ignore silently
  }
}

setInterval(pollTwinState, 5000);

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = process.env.PORT ?? 4000;
server.listen(PORT, () => {
  console.log(`Gateway listening on http://localhost:${PORT}`);
  console.log(`  ML       → http://localhost:8001  (via /api/predict, /api/explain, /api/model)`);
  console.log(`  Twin     → http://localhost:8002  (via /api/twin)`);
  console.log(`  Decision → http://localhost:8003  (via /api/decisions, /api/experiment, /api/config)`);
});
