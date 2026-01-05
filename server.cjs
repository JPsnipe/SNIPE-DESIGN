const http = require("http");
const fs = require("fs");
const path = require("path");
const { getPresets } = require("./src/shared/rig/presets.cjs");
const { runPhase1Simulation } = require("./src/shared/rig/runPhase1.cjs");

const PORT = 8080;
const RENDERER_DIR = path.join(__dirname, "src/renderer");

const MIME_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".woff": "application/font-woff",
    ".ttf": "application/font-ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".otf": "application/font-otf",
    ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    if (req.method === "GET") {
        if (req.url === "/api/presets") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(getPresets()));
            return;
        }

        let filePath = path.join(RENDERER_DIR, req.url === "/" ? "index.html" : req.url);
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
        req.on("data", (chunk) => {
            body += chunk.toString();
        });
        req.on("end", async () => {
            try {
                const payload = JSON.parse(body);
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
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Expose with: ngrok http ${PORT}`);
});
