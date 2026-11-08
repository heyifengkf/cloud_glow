// 朝霞 / 晚霞的「光线路径云图」
// 在微信 map 组件上按格子渲染云量，只覆盖太阳方位角方向的光线走廊 + 观测点上空。
const request = require('../../utils/request.js');
const solar = require('../../utils/solar.js');
const skymap = require('../../utils/skymap.js');

const LAYERS = [
  { key: 'low', name: '低云' },
  { key: 'mid', name: '中云' },
  { key: 'high', name: '高云' }
];

const CLOUD_KEYS = {
  low: 'cloud_cover_low',
  mid: 'cloud_cover_mid',
  high: 'cloud_cover_high'
};
// 总云量只用于画布评分，不参与分层渲染
const TOTAL_KEY = 'cloud_cover';

const DIST_RINGS_KM = [20, 40, 60, 80];

// 同一地点/时刻/数据源的网格数据在本次运行内复用，避免反复切换页面时重复取数
const GRID_CACHE_TTL = 10 * 60 * 1000;
let gridCache = null;

function cacheKey(c) {
  return [c.lat.toFixed(3), c.lon.toFixed(3), Math.round(c.bearing), c.dateStr, c.src].join('|');
}

// '2026-10-18T17:00' → 站点当地墙钟毫秒（与 cloudglow 的 wallMs 口径一致）
function wallMs(timeStr) {
  const s = String(timeStr);
  return Date.parse((s.length === 16 ? s + ':00' : s) + 'Z');
}

function nearestHourIndex(times, targetWall) {
  if (!times || !times.length) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(wallMs(times[i]) - targetWall);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const fmtPct = v => `${Math.round(v * 100)}%`;

Page({
  data: {
    loading: true,
    error: '',
    isDawn: false,
    title: '光线路径云图',
    locName: '--',
    dateLabel: '',
    timeLabel: '',
    bearingText: '0°',
    maxKm: skymap.MAX_KM,
    center: { latitude: 39.9042, longitude: 116.4074 },
    scale: 8,
    layers: LAYERS,
    layer: 'low',
    polygons: [],
    polyline: [],
    circles: [],
    includePoints: [],
    stats: null,
    verdict: null,
    logic: [],
    srcLabel: 'ECMWF',
    legendGradient: skymap.legendGradient('low'),
    cloudMin: 5
  },

  onLoad(options) {
    const num = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
    const lat = num(options.lat);
    const lon = num(options.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this.setData({ loading: false, error: '缺少定位信息，请从「火烧云」页重新进入' });
      return;
    }

    const kind = options.kind === 'dawn' ? 'dawn' : 'dusk';
    const eventWall = num(options.t);
    const bearing = num(options.az);
    const sunEl = num(options.el);
    const eventMs = Number.isFinite(eventWall) ? eventWall : Date.now();
    const src = options.src === 'gfs' || options.src === 'icon' ? options.src : 'ec';
    const name = options.name ? decodeURIComponent(options.name) : '当前位置';

    this._ctx = {
      lat,
      lon,
      kind,
      eventWall: eventMs,
      bearing: Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : 0,
      sunElevation: Number.isFinite(sunEl) ? sunEl : -0.833,
      src,
      dateStr: solar.wallDateStr(eventMs),
      name
    };

    const isDawn = kind === 'dawn';
    wx.setNavigationBarTitle({ title: isDawn ? '朝霞光线路径' : '晚霞光线路径' });

    this.setData({
      isDawn,
      title: isDawn ? '朝霞 · 光线路径云图' : '晚霞 · 光线路径云图',
      locName: name,
      dateLabel: solar.wallDateStr(eventMs).slice(5).replace('-', '/'),
      timeLabel: solar.formatWallTime(eventMs),
      bearingText: `${Math.round(this._ctx.bearing)}°`,
      srcLabel: src === 'gfs' ? 'GFS' : src === 'icon' ? 'ICON' : 'ECMWF'
    });

    this.buildMap();
    this.loadCloud();
  },

  // 地图几何与静态覆盖物（观测点、方位箭头、距离圈）
  buildMap() {
    const c = this._ctx;
    const grid = skymap.buildLightPath(c.lat, c.lon, c.bearing);
    this._grid = grid;

    const tip = skymap.destination(c.lat, c.lon, c.bearing, skymap.MAX_KM);
    const center = skymap.corridorCenter(c.lat, c.lon, c.bearing);

    const circles = [
      {
        latitude: c.lat,
        longitude: c.lon,
        radius: 700,
        color: '#f0a63c',
        fillColor: '#f0a63c66',
        strokeWidth: 2
      }
    ].concat(DIST_RINGS_KM.map(km => ({
      latitude: c.lat,
      longitude: c.lon,
      radius: km * 1000,
      color: '#2f8fffee',
      fillColor: '#00000000',
      strokeWidth: 2
    })));

    this.setData({
      center,
      circles,
      polyline: [{
        points: [{ latitude: c.lat, longitude: c.lon }, tip],
        color: '#f0a63ccc',
        width: 2,
        arrowLine: true
      }],
      includePoints: grid.points.concat([{ latitude: c.lat, longitude: c.lon }])
    });
  },

  async loadCloud() {
    const c = this._ctx;
    if (!c) return;
    this.setData({ loading: true, error: '' });

    let rows = null;
    const key = cacheKey(c);
    if (gridCache && gridCache.key === key && Date.now() - gridCache.at < GRID_CACHE_TTL) {
      rows = gridCache.rows;
    } else {
      try {
        rows = await request.fetchCloudGrid(this._grid.points, c.dateStr, c.src);
      } catch (e) {
        console.warn('[skymap] 取数异常', e);
      }
      if (rows) gridCache = { key, at: Date.now(), rows };
    }
    if (!rows) {
      this.setData({ loading: false, error: '云量数据获取失败，请检查网络或 request 合法域名（点击重试）' });
      return;
    }

    const vals = { low: [], mid: [], high: [], total: [] };
    rows.forEach(row => {
      const h = (row && row.hourly) || {};
      const idx = nearestHourIndex(h.time, c.eventWall);
      Object.keys(CLOUD_KEYS).forEach(k => {
        const arr = h[CLOUD_KEYS[k]];
        const v = idx >= 0 && arr ? Number(arr[idx]) : NaN;
        vals[k].push(Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 0);
      });
      const arrT = h[TOTAL_KEY];
      const vt = idx >= 0 && arrT ? Number(arrT[idx]) : NaN;
      vals.total.push(Number.isFinite(vt) ? Math.max(0, Math.min(1, vt / 100)) : NaN);
    });

    this._vals = vals;
    this.setData({ loading: false });
    this.renderLayer(this.data.layer);
    this.updateVerdict();
  },

  // 用本图云量判断是否会出现朝霞 / 晚霞，并把判断过程整理成可读的步骤
  updateVerdict() {
    const grid = this._grid;
    const vals = this._vals;
    if (!grid || !vals) return;

    const v = skymap.evaluatePath(grid, vals, {
      sunElevationDeg: this._ctx.sunElevation,
      cloudTotal: vals.total[0]
    });

    const pct = x => `${Math.round(x * 100)}%`;
    const fx = x => Number(x).toFixed(2);
    const mark = ok => (ok ? '✓ 被照亮' : '✗ 在阴影中');
    const az = Math.round(this._ctx.bearing);

    this.setData({
      verdict: {
        level: v.level,
        probPct: v.probPct,
        score: fx(v.score),
        kindLabel: this.data.isDawn ? '朝霞' : '晚霞'
      },
      logic: [
        {
          n: '①',
          k: '照亮高度',
          v: `太阳方位 ${az}°、高度角 ${v.sunElevationDeg}° → 云底高于 ${v.litKm.toFixed(1)}km 才被照亮；`
            + `高云 ${v.layers.high.z}km ${mark(v.layers.high.lit)}、`
            + `中云 ${v.layers.mid.z}km ${mark(v.layers.mid.lit)}、`
            + `低云 ${v.layers.low.z}km ${mark(v.layers.low.lit)}`
        },
        {
          n: '②',
          k: '画布评分',
          v: `地点上空 高云 ${pct(v.overhead.high)} / 中云 ${pct(v.overhead.mid)} / 低云 ${pct(v.overhead.low)}；`
            + `被照亮云量并集 ${pct(v.litCloud)} → 钟形响应得分 ${fx(v.canvas)}`
        },
        {
          n: '③',
          k: '光路遮挡',
          v: `沿 ${az}° 走廊 0–${skymap.MAX_KM}km 距离加权：低云 ${pct(v.path.low)} + `
            + `${v.params.midCloudWeight}×中云 ${pct(v.path.mid)} = 遮挡 ${pct(v.path.block)} → 门控 ${fx(v.gate)}`
        },
        {
          n: '④',
          k: '合成与概率',
          v: `Score = 门控 × 画布 = ${fx(v.gate)} × ${fx(v.canvas)} = ${fx(v.score)}；`
            + `P = σ(${v.params.probK}×(Score−${v.params.probTheta})) = ${v.probPct}%`
        }
      ]
    });
  },

  onSwitchLayer(e) {
    const layer = e.currentTarget.dataset.layer;
    if (!layer || layer === this.data.layer || !CLOUD_KEYS[layer]) return;
    this.setData({
      layer,
      legendGradient: skymap.legendGradient(layer)
    });
    this.renderLayer(layer);
  },

  // 云量阈值滑块：拖动中更新提示，松手后按阈值重绘地图覆盖
  onCloudMinChanging(e) {
    const v = Number(e.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ cloudMin: v });
  },

  onCloudMinChange(e) {
    const v = Number(e.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ cloudMin: v });
    this.renderLayer(this.data.layer);
  },

  renderLayer(layer) {
    const grid = this._grid;
    const vals = this._vals && this._vals[layer];
    if (!grid || !vals) return;

    // 云量阈值（0~1）：低于该值的云不显示（统计仍按 5% 口径）
    const minCover = Number(this.data.cloudMin) / 100 || 0;

    const polygons = [];
    let sum = 0;
    let max = 0;
    let covered = 0;

    grid.cells.forEach(cell => {
      const corners = cell.corners;
      const v = skymap.cellMean(cell, vals);

      sum += v;
      if (v > max) max = v;
      if (v >= 0.05) covered++;

      const fillColor = skymap.cloudColor(v, layer, minCover);
      if (!fillColor) return;
      polygons.push({
        points: corners.map(i => ({
          latitude: grid.points[i].latitude,
          longitude: grid.points[i].longitude
        })),
        fillColor,
        strokeWidth: 0,
        strokeColor: '#00000000',
        zIndex: 10
      });
    });

    const overhead = vals[0] || 0;
    this.setData({
      polygons,
      stats: {
        mean: fmtPct(grid.cells.length ? sum / grid.cells.length : 0),
        max: fmtPct(max),
        overhead: fmtPct(overhead),
        covered: `${covered}/${grid.cells.length}`
      }
    });
  },

  onRetry() {
    if (this.data.loading) return;
    this.loadCloud();
  }
});
