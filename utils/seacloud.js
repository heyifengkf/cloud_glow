// 云海预测算法
//
// 云海判据：低云在谷地铺开，且云顶高度低于观测点海拔（人站云上）；逆温层是云海稳定持久的保障。
//
// 结构（逐预报时刻计算）：
//   1) 云层识别：按气压层云量 + 相对湿度判定连续云段，得到云底/云顶高度与最大云量
//   2) 高度门控（乘性硬约束）：云顶必须低于观测点一定范围，否则归零
//   3) 云量门控（乘性硬约束）：云量太少/太多都扣分
//   4) 调节因子（加权）：逆温强度、近地面湿度、地面风速
//   5) 概率校准（Sigmoid，与火烧云 afterglow 一致）
//
// 输入单位：云量 %、相对湿度 %、位势高度 m、温度 ℃、风速 m/s、海拔 m。
// 所有阈值集中在下方 CFG，与逻辑分离，便于按站点/季节校准。

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const ramp = (x, x0, x1) => clamp((x - x0) / (x1 - x0), 0, 1);
const fall = (x, x0, x1) => 1 - ramp(x, x0, x1);
const num = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

const CFG = {
  // 云层判定：云量 ≥ coverMin 或 相对湿度 ≥ rhMin 视为有云
  cloud: { coverMin: 35, rhMin: 88, gapMaxM: 800, gapLevels: 2 },

  // 高度门控（Δ = 观测点海拔 − 云顶高度，米）
  height: { belowMax: -200, edgeMax: 0.4, bestMax: 300, fallX0: 1500, fallMin: 0.5, fallX1: 3500 },

  // 云量门控（%）：梯形
  cover: { min: 30, max: 90, floorHigh: 0.3 },

  // 逆温因子（℃）
  inversion: { base: 0.25, x1: 2, mid: 0.75, x2: 6 },

  // 近地面湿度因子（%）
  humid: { x0: 60, x1: 95, base: 0.2 },

  // 地面风速因子（m/s）
  wind: { x0: 2, x1: 8, mid: 0.4, x2: 15, floor: 0.05 },

  // 合成权重（三项和为 1）
  weights: { inversion: 0.35, humid: 0.30, wind: 0.35 },

  // 概率校准：P = σ(k·(S − θ))
  prob: { k: 6, theta: 0.45 }
};

const PROB_LEVELS = [
  { min: 0.80, label: '极高' },
  { min: 0.60, label: '较高' },
  { min: 0.40, label: '中等' },
  { min: 0.20, label: '低' },
  { min: -1, label: '不太可能' }
];

function pickLevel(levels, value) {
  for (let i = 0; i < levels.length; i++) {
    if (value >= levels[i].min) return levels[i];
  }
  return levels[levels.length - 1];
}

// 从最低气压层向上扫描，识别连续低云段（云海所在）
// levels 顺序为「从近地面到高空」；zArr 为对应层位势高度（米，海平面基准）。
function findLowCloudLayer(levels, cloudArr, rhArr, zArr) {
  const n = levels.length;
  const isCloud = li => {
    const c = num(cloudArr[li], -1);
    const r = num(rhArr[li], -1);
    return c >= CFG.cloud.coverMin || r >= CFG.cloud.rhMin;
  };

  let start = -1;
  for (let li = 0; li < n; li++) {
    if (isCloud(li)) { start = li; break; }
  }
  if (start < 0) return null;

  let end = start;
  let clearRun = 0;
  for (let li = start + 1; li < n; li++) {
    const dz = num(zArr[li], 0) - num(zArr[li - 1], 0);
    if (dz > CFG.cloud.gapMaxM) break;            // 高度断层，云海到此为止
    if (isCloud(li)) {
      clearRun = 0;
      end = li;
    } else {
      clearRun++;
      if (clearRun >= CFG.cloud.gapLevels) break; // 连续无云层，云海截断
    }
  }

  let maxCover = 0;
  for (let li = start; li <= end; li++) maxCover = Math.max(maxCover, num(cloudArr[li], 0));
  return { start, end, H_base: num(zArr[start], 0), H_top: num(zArr[end], 0), maxCover };
}

// 高度门控：云顶相对观测点的位置决定能不能看到云海
function heightGate(delta) {
  const h = CFG.height;
  if (delta <= h.belowMax) return 0;                                   // 云顶高于观测点
  if (delta <= 0) return h.edgeMax * ramp(delta, h.belowMax, 0);       // 边缘 0 → 0.4
  if (delta <= h.bestMax) return 1;                                    // 正好在脚下
  if (delta <= h.fallX0) return 1 - (1 - h.fallMin) * ramp(delta, h.bestMax, h.fallX0);
  return h.fallMin * fall(delta, h.fallX0, h.fallX1);                  // 云海偏低，衰减
}

// 云量门控：梯形
function coverGate(c) {
  const g = CFG.cover;
  if (c < g.min) return ramp(c, 0, g.min);
  if (c <= g.max) return 1;
  return g.floorHigh + (1 - g.floorHigh) * fall(c, g.max, 100);
}

// 逆温强度：云顶以上、观测点以下区间内正温差之和（℃）
function inversionStrength(levels, tempArr, zArr, H_top, H_obs) {
  let inv = 0;
  for (let li = 0; li < levels.length - 1; li++) {
    const z = num(zArr[li], 0);
    const zNext = num(zArr[li + 1], 0);
    if (z < H_top - 1 || zNext > H_obs + 1) continue;
    const dT = num(tempArr[li + 1], 0) - num(tempArr[li], 0);
    if (dT > 0) inv += dT;
  }
  return inv;
}

function inversionFactor(inv) {
  const g = CFG.inversion;
  if (inv <= 0) return g.base;
  if (inv <= g.x1) return g.base + (g.mid - g.base) * ramp(inv, 0, g.x1);
  return g.mid + (1 - g.mid) * ramp(inv, g.x1, g.x2);
}

function humidFactor(rh0) {
  const g = CFG.humid;
  if (rh0 <= g.x0) return g.base;
  if (rh0 >= g.x1) return 1;
  return g.base + (1 - g.base) * ramp(rh0, g.x0, g.x1);
}

function windFactor(w) {
  const g = CFG.wind;
  if (w <= g.x0) return 1;
  if (w <= g.x1) return 1 - (1 - g.mid) * ramp(w, g.x0, g.x1);
  if (w <= g.x2) return g.mid - (g.mid - g.floor) * ramp(w, g.x1, g.x2);
  return g.floor;
}

// 单时刻评估
// hourly: 含 time / wind_speed_10m / relative_humidity_2m / 各层 cloud_cover_*hPa
//         relative_humidity_*hPa / temperature_*hPa / geopotential_height_*hPa
// levels: [1000, ...] 从近地面到高空
// elevation: 观测点海拔（米）
function evaluateAt(hourly, levels, i, elevation) {
  const H_obs = elevation;
  const zArr = levels.map(h => num(hourly[`geopotential_height_${h}hPa`] && hourly[`geopotential_height_${h}hPa`][i], 0));
  const cArr = levels.map(h => num(hourly[`cloud_cover_${h}hPa`] && hourly[`cloud_cover_${h}hPa`][i], -1));
  const rArr = levels.map(h => num(hourly[`relative_humidity_${h}hPa`] && hourly[`relative_humidity_${h}hPa`][i], -1));
  const tArr = levels.map(h => num(hourly[`temperature_${h}hPa`] && hourly[`temperature_${h}hPa`][i], 0));

  const wind = num(hourly.wind_speed_10m && hourly.wind_speed_10m[i], 0);
  const rh0 = num(hourly.relative_humidity_2m && hourly.relative_humidity_2m[i], 0);

  const layer = findLowCloudLayer(levels, cArr, rArr, zArr);
  if (!layer) {
    return { index: i, time: hourly.time[i], hasCloud: false, probPct: 0, level: '无云海', score: 0 };
  }

  const delta = H_obs - layer.H_top;
  const hF = heightGate(delta);
  const cF = coverGate(layer.maxCover);
  const inv = inversionStrength(levels, tArr, zArr, layer.H_top, H_obs);
  const iF = inversionFactor(inv);
  const huF = humidFactor(rh0);
  const wF = windFactor(wind);

  const w = CFG.weights;
  const score = clamp(hF * cF * (w.inversion * iF + w.humid * huF + w.wind * wF), 0, 1);
  const p = CFG.prob;
  const prob = clamp(1 / (1 + Math.exp(-p.k * (score - p.theta))), 0, 1);
  const probPct = Math.round(prob * 100);
  const lvl = pickLevel(PROB_LEVELS, prob);

  return {
    index: i,
    time: hourly.time[i],
    hasCloud: true,
    cloudBase: Math.round(layer.H_base),
    cloudTop: Math.round(layer.H_top),
    cloudMax: Math.round(layer.maxCover),
    delta: Math.round(delta),
    heightF: hF,
    coverF: cF,
    inversion: Math.round(inv * 10) / 10,
    inversionF: iF,
    humidF: huF,
    windF: wF,
    wind,
    rh0: Math.round(rh0),
    score,
    probPct,
    level: lvl.label
  };
}

// 主入口：对全时段逐时刻评估，并汇总当前/未来 24h 最佳窗口
// 返回 { elevation, series, current, best24h }
function evaluate(hourly, levels, elevation) {
  const times = (hourly && hourly.time) || [];
  const series = [];
  for (let i = 0; i < times.length; i++) {
    series.push(evaluateAt(hourly, levels, i, elevation));
  }

  const current = series[0] || { probPct: 0, level: '—' };
  const horizon = Math.min(24, series.length);
  let best = current;
  for (let i = 0; i < horizon; i++) {
    if (series[i].probPct > best.probPct) best = series[i];
  }

  return { elevation, series, current, best24h: best };
}

// 构建未来 hours 小时的海拔-云层剖面数据（供画布绘制）。
// 返回 levelAlts（各气压层位势高度，取首小时）、grid[层][小时]（0~1 云量）、
// columns（每小时时间戳）。纵轴固定 0~4000m。
function buildAltitudeProfile(hourly, levels, elevation, hours = 24) {
  const times = (hourly && hourly.time) || [];
  const n = Math.min(hours, times.length);
  const nL = levels.length;
  const ceiling = 4000;

  // grid[li][i] = 0~1 云量，取本层与上一层较大值（与「云图」页一致，云段连成片）
  const grid = [];
  for (let li = 0; li < nL; li++) grid.push(new Array(n).fill(0));

  let levelAlts = null;
  const columns = [];

  for (let i = 0; i < n; i++) {
    const z = levels.map(h => num(hourly[`geopotential_height_${h}hPa`] && hourly[`geopotential_height_${h}hPa`][i], 0));
    const c = levels.map(h => (num(hourly[`cloud_cover_${h}hPa`] && hourly[`cloud_cover_${h}hPa`][i], 0)) / 100);
    if (levelAlts === null) levelAlts = z;
    for (let li = 0; li < nL; li++) {
      grid[li][i] = Math.max(c[li], c[Math.min(li + 1, nL - 1)]);
    }
    columns.push({ time: times[i] });
  }

  return { elevation, ceiling, levelAlts: levelAlts || [], grid, columns };
}

module.exports = {
  CFG,
  PROB_LEVELS,
  evaluate,
  evaluateAt,
  buildAltitudeProfile,
  findLowCloudLayer,
  clamp,
  ramp,
  fall,
  num
};
