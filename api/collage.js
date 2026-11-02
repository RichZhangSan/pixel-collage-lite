import "../lib/load-env.js";
import { getPredictionResult, startPrediction } from "../lib/replicate.js";
import { allowPrediction, clientKey } from "../lib/rate-limit.js";

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.reject(Object.assign(new Error("请求格式不是有效 JSON。"), { statusCode: 400 }));
    }
  }
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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "GET") {
    const id = req.query?.id || new URL(req.url, "http://localhost").searchParams.get("id");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "缺少有效的任务 ID。" }));
      return;
    }
    try {
      const result = await getPredictionResult(id);
      res.statusCode = result.status === "failed" || result.status === "canceled" ? 502 : 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error.statusCode || 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error.message || "服务器处理失败。" }));
    }
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "只支持 POST /api/collage 和 GET /api/collage?id=..." }));
    return;
  }

  try {
    if (!allowPrediction(clientKey(req))) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "60");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "请求过于频繁，请稍后再试。" }));
      return;
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
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ...result, provider: "replicate-sam2" }));
  } catch (error) {
    res.statusCode = error.statusCode || 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: error.message || "服务器处理失败。" }));
  }
}
