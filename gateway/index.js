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
// Proxy helper — strips the /api prefix before forwarding.
//
// WHY pathFilter instead of app.use(path, middleware):
//   In hpm v3, when you mount via app.use("/api/experiment", middleware),
//   Express strips the mount prefix before hpm sees the URL — so hpm
//   receives "/start" instead of "/api/experiment/start" and pathRewrite
//   never matches.  Using pathFilter attaches the middleware at the root,
//   so hpm sees the full URL and can strip /api correctly.
// --------------------------------------------------------------------------
function proxy(target, paths) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathFilter: paths,               // hpm v3: glob patterns to match
    pathRewrite: { "^/api": "" },   // /api/experiment/start → /experiment/start
  });
}

// --------------------------------------------------------------------------
// Route → service mapping  (all mounted at root so full URL reaches hpm)
// --------------------------------------------------------------------------
app.use(proxy("http://localhost:8001", ["/api/predict/**", "/api/explain/**", "/api/model/**"]));
app.use(proxy("http://localhost:8002", ["/api/twin/**"]));
app.use(proxy("http://localhost:8003", ["/api/decisions/**", "/api/experiment/**", "/api/config/**"]));

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
