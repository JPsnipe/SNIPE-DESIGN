const http = require("http");
const fs = require("fs");
const path = require("path");

// Reusing shared simulation logic from the main project
const { getPresets } = require("../src/shared/rig/presets.cjs");
const { runPhase1Simulation } = require("../src/shared/rig/runPhase1.cjs");

const PORT = 8081;
const MOBILE_DIR = __dirname;

const MIME_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
    console.log(`[Mobile Server] ${req.method} ${req.url}`);

    if (req.method === "GET") {
        if (req.url === "/api/presets") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(getPresets()));
            return;
        }

        let filePath = path.join(MOBILE_DIR, req.url === "/" ? "index.html" : req.url);
        const extname = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[extname] || "application/octet-stream";

        fs.readFile(filePath, (error, content) => {
            if (error) {
                if (error.code === "ENOENT") {
                    res.writeHead(404);
                    res.end("File not found");
                } else {
                    res.writeHead(500);
                    res.end(`Server error: ${error.code}`);
                }
            } else {
                res.writeHead(200, { "Content-Type": contentType });
                res.end(content, "utf-8");
            }
        });
    } else if (req.method === "POST" && req.url === "/api/simulate") {
        let body = "";
        req.on("data", (chunk) => body += chunk.toString());
        req.on("end", async () => {
            try {
                const payload = JSON.parse(body);
                // The simulation logic lives in src/shared/rig
                const results = await runPhase1Simulation(payload);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(results));
            } catch (err) {
                console.error("Simulation error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(405);
        res.end("Method not allowed");
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 SnipeDesign Mobile Server running at http://localhost:${PORT}/`);
    console.log(`📡 To test on your phone, use: ngrok http ${PORT}\n`);
});
