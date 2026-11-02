const state = {
  sourceDataUrl: "",
  sourceImage: null,
  resultCanvas: document.querySelector("#resultCanvas"),
  rng: null
};

const $ = (selector) => document.querySelector(selector);
const fileInput = $("#fileInput");
const dropzone = $("#dropzone");
const previewWrap = $("#previewWrap");
const previewImage = $("#previewImage");
const fileLabel = $("#fileLabel");
const generateButton = $("#generateButton");
const downloadButton = $("#downloadButton");
const emptyState = $("#emptyState");
const resultMeta = $("#resultMeta");
const apiStatus = $("#apiStatus");
const countInput = $("#count");
const countValue = $("#countValue");

countInput.addEventListener("input", () => { countValue.textContent = countInput.value; });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
$("#clearButton").addEventListener("click", clearFile);
generateButton.addEventListener("click", generate);
downloadButton.addEventListener("click", downloadResult);
["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) loadFile(file);
});

function setStatus(text, kind = "") {
  apiStatus.textContent = text;
  apiStatus.className = `status-pill ${kind}`;
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error();
    const data = await response.json();
    setStatus(data.configured ? "云端已配置" : "等待配置", data.configured ? "ready" : "");
  } catch {
    setStatus("本地服务未启动", "error");
  }
}

function loadFile(file) {
  if (!file.type.startsWith("image/")) return setStatus("请选择图片文件", "error");
  const reader = new FileReader();
  reader.onload = () => resizeImage(reader.result).then((dataUrl) => {
    state.sourceDataUrl = dataUrl;
    state.sourceImage = new Image();
    state.sourceImage.onload = () => {
      previewImage.src = dataUrl;
      previewWrap.classList.remove("hidden");
      fileLabel.textContent = file.name;
      generateButton.disabled = false;
      setStatus("图片已就绪", "ready");
      resultMeta.textContent = `${state.sourceImage.naturalWidth} × ${state.sourceImage.naturalHeight} · 等待生成`;
    };
    state.sourceImage.onerror = () => setStatus("图片读取失败，请换一张图片重试", "error");
    state.sourceImage.src = dataUrl;
  }).catch(() => setStatus("图片读取失败，请换一张图片重试", "error"));
  reader.onerror = () => setStatus("图片读取失败，请重试", "error");
  reader.readAsDataURL(file);
}

function resizeImage(dataUrl, maxSide = 1500) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxDataUrlLength = 3.5 * 1024 * 1024;
      let currentMaxSide = maxSide;
      while (currentMaxSide >= 640) {
        const scale = Math.min(1, currentMaxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("浏览器无法处理这张图片。"));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const output = canvas.toDataURL("image/jpeg", .86);
        if (output.length <= maxDataUrlLength) {
          resolve(output);
          return;
        }
        currentMaxSide = Math.floor(currentMaxSide * .85);
      }
      reject(new Error("图片压缩后仍然过大，请选择较小的图片。"));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function clearFile() {
  fileInput.value = "";
  state.sourceDataUrl = "";
  state.sourceImage = null;
  previewWrap.classList.add("hidden");
  generateButton.disabled = true;
  downloadButton.disabled = true;
  $("#resultCanvas").classList.add("hidden");
  emptyState.classList.remove("hidden");
  resultMeta.textContent = "尚未生成";
  setStatus("等待配置");
}

async function generate() {
  if (!state.sourceDataUrl) return;
  const count = Number(countInput.value);
  const seed = Number($("#seed").value) || 1;
  state.rng = mulberry32(seed);
  generateButton.disabled = true;
  downloadButton.disabled = true;
  setStatus("云端分割中…");
  resultMeta.textContent = "正在识别图片中的主体，请稍候";
  try {
    const response = await fetch("/api/collage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: state.sourceDataUrl, count })
    });
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || "云端处理失败");
    const payload = await pollPrediction(started.predictionId);
    setStatus("正在本地合成…", "ready");
    const masks = await loadImages(payload.masks || []);
    const subjects = await selectSubjects(masks, state.sourceImage, count);
    if (!subjects.length) throw new Error("没有得到可用主体，请换一张主体更清晰的图片重试。");
    await renderCollage(subjects, state.sourceImage, $("#background").value, $("#style").value);
    setStatus("生成完成", "ready");
    resultMeta.textContent = `${subjects.length} 个主体 · ${state.sourceImage.naturalWidth} × ${state.sourceImage.naturalHeight} · ${payload.provider}`;
    downloadButton.disabled = false;
  } catch (error) {
    setStatus("生成失败", "error");
    resultMeta.textContent = error.message;
  } finally {
    generateButton.disabled = false;
  }
}

async function pollPrediction(id) {
  if (typeof id !== "string" || !id) throw new Error("云端没有返回有效的任务 ID。");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`/api/collage?id=${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "云端分割失败");
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "canceled") {
      throw new Error(payload.error || "云端分割失败");
    }
    resultMeta.textContent = `云端分割中… ${Math.min(attempt + 1, 150) * 2} 秒`;
  }
  throw new Error("云端分割等待超时，请稍后重试。");
}

function loadImages(urls) {
  return Promise.all(urls.map((url) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  })));
}

async function selectSubjects(maskImages, sourceImage, count) {
  const candidates = [];
  for (const maskImage of maskImages) {
    const info = analyzeMask(maskImage, 128);
    if (info.area < .012 || info.area > .72 || info.width < .08 || info.height < .08) continue;
    if (candidates.some((item) => overlap(item.info, info) > .72)) continue;
    candidates.push({ maskImage, info });
    if (candidates.length >= count * 2) break;
  }
  candidates.sort((a, b) => (b.info.area * (1 - b.info.area) - a.info.area * (1 - a.info.area)));
  const chosen = candidates.slice(0, count);
  const result = [];
  for (const candidate of chosen) {
    const subject = await makeSubject(sourceImage, candidate.maskImage, candidate.info);
    if (subject) result.push(subject);
  }
  return result;
}

function analyzeMask(maskImage, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(maskImage, 0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  let minX = size, minY = size, maxX = -1, maxY = -1, active = 0;
  let alphaMin = 255, alphaMax = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    alphaMin = Math.min(alphaMin, pixels[i + 3]);
    alphaMax = Math.max(alphaMax, pixels[i + 3]);
  }
  const transparentMask = alphaMin < 245;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      const value = transparentMask ? pixels[i + 3] : lum;
      if (value > 80) {
        active += 1;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return { area: 0, x: 0, y: 0, width: 0, height: 0 };
  return { area: active / (size * size), x: minX / size, y: minY / size, width: (maxX - minX + 1) / size, height: (maxY - minY + 1) / size };
}

function overlap(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

async function makeSubject(sourceImage, maskImage, info) {
  const width = sourceImage.naturalWidth, height = sourceImage.naturalHeight;
  const pad = Math.round(Math.min(width, height) * .035);
  const x = Math.max(0, Math.floor(info.x * width - pad));
  const y = Math.max(0, Math.floor(info.y * height - pad));
  const w = Math.min(width - x, Math.ceil(info.width * width + pad * 2));
  const h = Math.min(height - y, Math.ceil(info.height * height + pad * 2));
  if (w < 30 || h < 30) return null;
  const source = document.createElement("canvas");
  source.width = w; source.height = h;
  source.getContext("2d").drawImage(sourceImage, x, y, w, h, 0, 0, w, h);
  const mask = document.createElement("canvas");
  mask.width = w; mask.height = h;
  const maskCtx = mask.getContext("2d", { willReadFrequently: true });
  maskCtx.drawImage(maskImage, x / width * maskImage.width, y / height * maskImage.height, w / width * maskImage.width, h / height * maskImage.height, 0, 0, w, h);
  const maskData = maskCtx.getImageData(0, 0, w, h);
  const paper = document.createElement("canvas");
  paper.width = w; paper.height = h;
  const paperCtx = paper.getContext("2d");
  paperCtx.drawImage(source, 0, 0);
  const pixels = paperCtx.getImageData(0, 0, w, h);
  const maskPixels = maskData.data;
  const alphaMin = getAlphaMin(maskPixels);
  for (let i = 0; i < maskPixels.length; i += 4) {
    const lum = (maskPixels[i] + maskPixels[i + 1] + maskPixels[i + 2]) / 3;
    const base = alphaMin < 245 ? maskPixels[i + 3] : lum;
    pixels.data[i + 3] = Math.max(0, Math.min(255, base * .93));
  }
  paperCtx.putImageData(pixels, 0, 0);
  return { canvas: paper, mask, width: w, height: h, info };
}

function getAlphaMin(data) {
  let min = 255;
  for (let i = 3; i < data.length; i += 4) min = Math.min(min, data[i]);
  return min;
}

async function renderCollage(subjects, sourceImage, background, style) {
  const canvas = state.resultCanvas;
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
  canvas.width = Math.round(sourceImage.naturalWidth * scale);
  canvas.height = Math.round(sourceImage.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx, canvas, sourceImage, background);
  const placements = placementsFor(subjects, canvas.width, canvas.height, style);
  placements.forEach((placement, index) => drawSticker(ctx, subjects[index].canvas, placement, index));
  emptyState.classList.add("hidden");
  canvas.classList.remove("hidden");
}

function drawBackground(ctx, canvas, sourceImage, background) {
  if (background === "transparent") { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  if (background === "original") { ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height); return; }
  ctx.fillStyle = background === "paper" ? "#f4efe6" : "#d9d4ce";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "rgba(255,255,255,.35)");
  gradient.addColorStop(1, "rgba(120,100,80,.06)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function placementsFor(subjects, width, height, style) {
  const slots = [];
  subjects.forEach((subject, index) => {
    const ratio = subject.width / subject.height;
    let x, y, targetH;
    if (style === "diagonal") {
      x = width * (.06 + index * .13); y = height * (.10 + index * .11); targetH = height * (.23 + (index % 3) * .06);
    } else if (style === "scattered") {
      x = width * (.04 + ((index * 37) % 81) / 100); y = height * (.06 + ((index * 59) % 83) / 100); targetH = height * (.18 + (index % 4) * .05);
    } else if (style === "stacked") {
      x = width * (.18 + (index % 3) * .22); y = height * (.14 + (index % 2) * .29); targetH = height * (.27 + (index % 3) * .04);
    } else {
      const grid = [[.06, .09, .28], [.60, .10, .25], [.28, .38, .34], [.06, .68, .22], [.70, .67, .25], [.42, .76, .18], [.80, .38, .16]];
      const slot = grid[index % grid.length]; x = width * slot[0]; y = height * slot[1]; targetH = height * slot[2];
    }
    targetH = Math.max(1, Math.min(height * .45, targetH));
    let targetW = targetH * ratio;
    const fitScale = Math.min(1, width * .72 / targetW, height * .72 / targetH);
    targetW *= fitScale;
    targetH *= fitScale;
    const angle = (random() - .5) * .28;
    const paper = Math.min(18, targetH * .06);
    const sin = Math.abs(Math.sin(angle));
    const cos = Math.abs(Math.cos(angle));
    const extentX = (targetW / 2 + paper) * cos + (targetH / 2 + paper) * sin;
    const extentY = (targetW / 2 + paper) * sin + (targetH / 2 + paper) * cos;
    const centerX = clamp(x + targetW / 2, extentX, width - extentX);
    const centerY = clamp(y + targetH / 2, extentY, height - extentY);
    slots.push({ x: centerX - targetW / 2, y: centerY - targetH / 2, width: targetW, height: targetH, angle, alpha: .78 + random() * .18, paper });
  });
  return slots;
}

function clamp(value, min, max) {
  if (max < min) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function drawSticker(ctx, image, placement, index) {
  ctx.save();
  const cx = placement.x + placement.width / 2;
  const cy = placement.y + placement.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(placement.angle);
  ctx.shadowColor = "rgba(63, 45, 31, .24)";
  ctx.shadowBlur = 13;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 7;
  ctx.globalAlpha = placement.alpha;
  ctx.fillStyle = index % 2 ? "#f8f1e7" : "#eee5d7";
  tornPaperPath(ctx, placement.width, placement.height, placement.paper, index);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = placement.alpha;
  ctx.drawImage(image, -placement.width / 2, -placement.height / 2, placement.width, placement.height);
  ctx.restore();
}

function tornPaperPath(ctx, width, height, padding, index) {
  const left = -width / 2 - padding;
  const top = -height / 2 - padding;
  const right = width / 2 + padding;
  const bottom = height / 2 + padding;
  const points = [];
  const steps = Math.max(4, Math.round(width / 42));
  const jitter = Math.max(2, padding * .42);
  const edge = (start, end, fixed, horizontal) => {
    for (let i = 0; i <= steps; i += 1) {
      const ratio = i / steps;
      const wobble = ((index + i * 17) % 5 - 2) * jitter / 2;
      points.push(horizontal ? [start + (end - start) * ratio, fixed + wobble] : [fixed + wobble, start + (end - start) * ratio]);
    }
  };
  edge(left, right, top, true);
  edge(top, bottom, right, false);
  edge(right, left, bottom, true);
  edge(bottom, top, left, false);
  ctx.beginPath();
  points.forEach(([x, y], pointIndex) => pointIndex ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
}

function random() { return state.rng ? state.rng() : Math.random(); }
function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function downloadResult() {
  if (!state.resultCanvas.width) return;
  const link = document.createElement("a");
  link.download = `pixel-collage-${Date.now()}.png`;
  link.href = state.resultCanvas.toDataURL("image/png");
  link.click();
}

checkHealth();
