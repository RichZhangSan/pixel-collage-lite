import "./lib/load-env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPredictionResult, health, startPrediction } from "./lib/replicate.js";
import { allowPrediction, clientKey } from "./lib/rate-limit.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8787);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) {
        reject(Object.assign(new Error("图片请求过大，请先压缩图片。"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("请求格式不是有效 JSON。"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    json(res, 200, health());
    return true;
  }
  if (url.pathname !== "/api/collage") return false;
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      json(res, 400, { error: "缺少有效的任务 ID。" });
      return true;
    }
    try {
      const result = await getPredictionResult(id);
      json(res, result.status === "failed" || result.status === "canceled" ? 502 : 200, result);
    } catch (error) {
      json(res, error.statusCode || 500, { error: error.message || "服务器处理失败。" });
    }
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "只支持 POST /api/collage 和 GET /api/collage?id=..." });
    return true;
  }
  try {
    if (!allowPrediction(clientKey(req))) {
      res.setHeader("Retry-After", "60");
      json(res, 429, { error: "请求过于频繁，请稍后再试。" });
      return true;
    }
    const body = await readBody(req);
    if (typeof body.image !== "string" || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
      throw Object.assign(new Error("请上传有效的图片。"), { statusCode: 400 });
    }
    if (body.image.length > 3.5 * 1024 * 1024) {
      throw Object.assign(new Error("图片请求过大，请选择较小的图片。"), { statusCode: 413 });
    }
    const count = Math.min(7, Math.max(3, Number(body.count) || 5));
    const result = await startPrediction(body.image, count);
    json(res, 202, { ...result, provider: "replicate-sam2" });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message || "服务器处理失败。" });
  }
  return true;
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  const relativePath = path.relative(publicDir, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (pathname !== "/index.html") {
        res.statusCode = 404;
        res.end("Not found");
      } else {
        res.statusCode = 500;
        res.end("Missing public/index.html");
      }
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", mime[path.extname(filePath)] || "application/octet-stream");
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, url);
    if (handled) return;
  }
  serveStatic(req, res, url);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Pixel Collage Lite running at http://127.0.0.1:${port}`);
});
