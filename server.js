import http from "http";
import handler from "./api/index.js";

const PORT = process.env.PORT || 3211;

const server = http.createServer(async (req, res) => {
  // Wrap res.status and res.json to match Vercel/Express interface
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return res;
  };

  if (req.method === "POST") {
    let bodyStr = "";
    req.on("data", chunk => bodyStr += chunk);
    req.on("end", async () => {
      try {
        req.body = JSON.parse(bodyStr);
      } catch (e) {
        req.body = {};
      }
      try {
        await handler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: { message: err.message } });
        }
      }
    });
  } else {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message } });
      }
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local OpenCode Free Proxy running on http://127.0.0.1:${PORT}`);
});
