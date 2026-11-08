// 光线路径云图几何：以观测点为原点，沿太阳方位角（光线来向）向外布置采样网格。
// 只覆盖「光线经过 + 地点上空」的走廊，不做大范围/全国渲染。

const config = require('./config.js');
const solar = require('./solar.js');

const RAD = Math.PI / 180;

// 沿路径的距离环（km），相邻两环之间的横向区间构成一个云量格子
const RINGS_KM = [0, 8, 16, 26, 38, 52, 68, 86];
// 每环的横向采样位置（-1~1，乘以该距离处的半宽）
const LATERAL_FRACS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
// 走廊半宽：距离越远越宽（光线发散）
const MIN_HALF_WIDTH_KM = 5;
const HALF_WIDTH_RATIO = 0.3;

const LAYER_COLORS = {
  low: [91, 155, 213],
  mid: [155, 123, 213],
  high: [255, 87, 145]
};

const MAX_KM = RINGS_KM[RINGS_KM.length - 1];

function normLon(lon) {
  return ((lon + 540) % 360) - 180;
}

// 球面正算：从 (lat, lon) 沿 bearing（正北起顺时针，度）走 distKm
function destination(lat, lon, bearingDeg, distKm) {
  const d = distKm / 6371;
  const br = bearingDeg * RAD;
  const lat1 = lat * RAD;
  const lon1 = lon * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { latitude: lat2 / RAD, longitude: normLon(lon2 / RAD) };
}

function halfWidthKm(d) {
  return Math.max(MIN_HALF_WIDTH_KM, d * HALF_WIDTH_RATIO);
}

// 生成采样点与格子。
// points[i] = { latitude, longitude }；cells[n].corners 为格子四角在 points 中的下标
// （第 0 环塌缩到观测点，故最内圈格子是三边形）。
function buildLightPath(lat, lon, bearingDeg) {
  const bearing = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const points = [];
  const rings = [];

  RINGS_KM.forEach(d => {
    const row = [];
    if (d === 0) {
      points.push(destination(lat, lon, bearing, 0));
      const idx = points.length - 1;
      LATERAL_FRACS.forEach(() => row.push(idx));
    } else {
      const hw = halfWidthKm(d);
      LATERAL_FRACS.forEach(f => {
        const lateral = f * hw;
        const dist = Math.sqrt(d * d + lateral * lateral);
        const brg = bearing + Math.atan2(lateral, d) / RAD;
        points.push(destination(lat, lon, brg, dist));
        row.push(points.length - 1);
      });
    }
    rings.push(row);
  });

  const cells = [];
  for (let r = 0; r < RINGS_KM.length - 1; r++) {
    for (let s = 0; s < LATERAL_FRACS.length - 1; s++) {
      const quad = [rings[r][s], rings[r][s + 1], rings[r + 1][s + 1], rings[r + 1][s]];
      // 内侧塌缩的点会重复出现，去重后成为三角形
      const corners = quad.filter((v, i) => quad.indexOf(v) === i);
      cells.push({ ring: r, seg: s, corners });
    }
  }

  return { points, cells, ringsKm: RINGS_KM.slice(), bearing, center: { latitude: lat, longitude: lon } };
}

// 地图初始视野中心：走廊中段
function corridorCenter(lat, lon, bearingDeg) {
  return destination(lat, lon, bearingDeg, MAX_KM * 0.45);
}

// 云量 0~1 → map 组件可用的 8 位十六进制颜色；低于 5% 视为无云
function cloudColor(v, layer) {
  if (!(v >= 0.05)) return '';
  const c = LAYER_COLORS[layer] || LAYER_COLORS.low;
  const a = Math.round(Math.min(0.82, 0.10 + v * 0.72) * 255);
  return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('')
    + a.toString(16).padStart(2, '0');
}

// 图例渐变：无云 → 满云
function legendGradient(layer) {
  const c = LAYER_COLORS[layer] || LAYER_COLORS.low;
  const solid = `rgb(${c[0]},${c[1]},${c[2]})`;
  const soft = `rgba(${c[0]},${c[1]},${c[2]},0.08)`;
  return `linear-gradient(90deg, ${soft}, ${solid})`;
}

// 一个格子的云量：四角（内侧格子为三角）均值
function cellMean(cell, arr) {
  let s = 0;
  for (let i = 0; i < cell.corners.length; i++) s += arr[cell.corners[i]] || 0;
  return s / cell.corners.length;
}

// ============ 是否会出现朝霞 / 晚霞的判断 ============
// 只用本图的云量数据，分三步（阈值全部取自 config.CFG，与「火烧云」页同源）：
//   ① 照亮高度：由太阳高度角算出云底高于多少 km 才仍被阳光照到
//   ② 画布评分：观测点上空被照亮的中/高云有多少（钟形：太少无画布，太多糊成灰）
//   ③ 光路遮挡：沿太阳方位角走廊的低云 / 中云按距离加权，决定阳光能否过来
// 输出 Score = 门控 × 画布，再用同一套 Platt 校准映射成概率。

const PATH_SCALE_KM = 40;   // 距离权重尺度：40km 外遮挡作用衰减到一半
const clamp01 = x => Math.max(0, Math.min(1, x));
const ramp = (x, x0, x1) => clamp01((x - x0) / (x1 - x0));
const bell = (x, mu, sigma) => Math.exp(-Math.pow((x - mu) / sigma, 2));

function cellMidKm(ring) {
  return (RINGS_KM[ring] + RINGS_KM[ring + 1]) / 2;
}

// opts: { sunElevationDeg, cloudTotal? }
function evaluatePath(grid, vals, opts) {
  const o = opts || {};
  const cfg = config.CFG;
  const g = cfg.gate;
  const c = cfg.canvas;

  // ---- ③ 光路遮挡：走廊上低云 + midCloudWeight × 中云 ----
  let wSum = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  grid.cells.forEach(cell => {
    const w = 1 / (1 + cellMidKm(cell.ring) / PATH_SCALE_KM);
    wSum += w;
    low += w * cellMean(cell, vals.low || []);
    mid += w * cellMean(cell, vals.mid || []);
    high += w * cellMean(cell, vals.high || []);
  });
  if (wSum > 0) {
    low /= wSum;
    mid /= wSum;
    high /= wSum;
  }

  const block = Math.min(1, low + g.midCloudWeight * mid);
  const gate = 1 - g.lowCloud.soft * ramp(block, g.lowCloud.x0, g.lowCloud.x1);

  // ---- ② 画布评分：观测点上空（走廊第 0 个采样点）----
  const overhead = {
    low: (vals.low || [])[0] || 0,
    mid: (vals.mid || [])[0] || 0,
    high: (vals.high || [])[0] || 0
  };
  // 缺总云量时按独立事件取并集，作为兜底
  const total = Number.isFinite(o.cloudTotal)
    ? clamp01(o.cloudTotal)
    : 1 - (1 - overhead.high) * (1 - overhead.mid) * (1 - overhead.low);

  const canvas = clamp01(
    c.high.w * bell(overhead.high, c.high.mu, c.high.sigma)
    + c.mid.w * bell(overhead.mid, c.mid.mu, c.mid.sigma)
    + c.low.w * bell(overhead.low, c.low.mu, c.low.sigma)
    + c.total.w * bell(total, c.total.mu, c.total.sigma)
  );

  const score = clamp01(gate * canvas);

  // ---- 概率校准（与 afterglow.evaluate 相同的 Sigmoid）----
  const prob = clamp01(1 / (1 + Math.exp(-cfg.prob.k * (score - cfg.prob.theta))));
  let level = config.PROB_LEVELS[config.PROB_LEVELS.length - 1].label;
  for (let i = 0; i < config.PROB_LEVELS.length; i++) {
    if (prob >= config.PROB_LEVELS[i].min) { level = config.PROB_LEVELS[i].label; break; }
  }

  // ---- ① 照亮高度与各层是否被照亮 ----
  const el = Number.isFinite(o.sunElevationDeg) ? o.sunElevationDeg : -0.833;
  const litKm = solar.litAltitudeKm(el);
  const layers = {
    high: { z: cfg.layerZ.high, lit: cfg.layerZ.high >= litKm },
    mid: { z: cfg.layerZ.mid, lit: cfg.layerZ.mid >= litKm },
    low: { z: cfg.layerZ.low, lit: cfg.layerZ.low >= litKm }
  };

  // 被照亮云量并集：只有被阳光照到的层才能当画布
  const litCloud = 1
    - (1 - (layers.high.lit ? overhead.high : 0))
    * (1 - (layers.mid.lit ? overhead.mid : 0))
    * (1 - (layers.low.lit ? overhead.low : 0));

  return {
    sunElevationDeg: el,
    litKm,
    layers,
    litCloud,
    overhead: { low: overhead.low, mid: overhead.mid, high: overhead.high, total },
    path: { low, mid, high, block, scaleKm: PATH_SCALE_KM },
    gate,
    canvas,
    score,
    prob,
    probPct: Math.round(prob * 100),
    level,
    params: {
      midCloudWeight: g.midCloudWeight,
      blockX0: g.lowCloud.x0,
      blockX1: g.lowCloud.x1,
      gateSoft: g.lowCloud.soft,
      probK: cfg.prob.k,
      probTheta: cfg.prob.theta
    }
  };
}

module.exports = {
  RINGS_KM,
  LATERAL_FRACS,
  MAX_KM,
  PATH_SCALE_KM,
  destination,
  halfWidthKm,
  buildLightPath,
  corridorCenter,
  cloudColor,
  legendGradient,
  cellMean,
  evaluatePath
};
