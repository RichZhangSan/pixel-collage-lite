const DEFAULT_VERSION = "be7cbde9fdf0eecdc8b20ffec9dd0d1cfeace0832d4d0b58a071d993182e1be0";
const API_ROOT = "https://api.replicate.com/v1";

function getToken() {
  return process.env.REPLICATE_API_TOKEN || "";
}

function getVersion() {
  return process.env.REPLICATE_MODEL_VERSION || DEFAULT_VERSION;
}

async function replicateRequest(path, init = {}) {
  const token = getToken();
  if (!token) {
    const error = new Error("缺少 REPLICATE_API_TOKEN。请复制 .env.example 为 .env 并填入 Replicate Token。");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }

  if (!response.ok) {
    const error = new Error(data.detail || data.error || `Replicate API 返回 ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

export async function startPrediction(imageDataUrl, count = 5) {
  const maskLimit = Math.min(24, Math.max(12, count * 4));
  const prediction = await replicateRequest("/predictions", {
    method: "POST",
    body: JSON.stringify({
      version: getVersion(),
      input: {
        image: imageDataUrl,
        mask_limit: maskLimit,
        points_per_side: 32,
        points_per_batch: 128,
        pred_iou_thresh: 0.78,
        stability_score_thresh: 0.92,
        crop_n_layers: 1,
        min_mask_region_area: 100,
        mask_2_mask: true,
        multimask_output: false
      }
    })
  });

  if (!prediction.id) {
    const error = new Error("Replicate 没有返回任务 ID。");
    error.statusCode = 502;
    throw error;
  }
  return { id: prediction.id, status: prediction.status || "starting" };
}

async function fetchAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`读取 mask 结果失败：${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

export async function getPredictionResult(id) {
  const prediction = await replicateRequest(`/predictions/${encodeURIComponent(id)}`);
  if (prediction.status === "succeeded") {
    const outputs = Array.isArray(prediction.output) ? prediction.output : [prediction.output];
    const maskUrls = outputs.filter((item) => typeof item === "string").slice(0, 24);
    const masks = await Promise.all(maskUrls.map(fetchAsDataUrl));
    return { status: "succeeded", masks, provider: "replicate-sam2", predictionId: id };
  }

  if (["failed", "canceled"].includes(prediction.status)) {
    return {
      status: prediction.status,
      error: prediction.error || "云端分割失败。",
      provider: "replicate-sam2",
      predictionId: id
    };
  }

  return { status: prediction.status || "processing", provider: "replicate-sam2", predictionId: id };
}

export function health() {
  return {
    configured: Boolean(getToken()),
    provider: "replicate-sam2",
    modelVersion: getVersion()
  };
}
