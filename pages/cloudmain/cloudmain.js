const request = require('../../utils/request.js');

// ============ 气压层（与 web/js/main.js 的 PRESSURE_LEVELS 一致） ============
// hPa 层的顺序来自 request.LEVELS_HPAS（API 契约），这里只补上高度与刻度文字，
// 避免两处各写一份清单而产生漂移。
const ALT_BY_HPA = {
  1000: 110, 975: 320, 950: 500, 925: 800, 900: 1000, 850: 1500, 800: 1900,
  700: 3000, 600: 4200, 500: 5600, 400: 7200, 300: 9200, 250: 10400,
  200: 11800, 150: 13600, 100: 16200, 70: 18400, 50: 20500, 30: 23900, 20: 26500, 10: 31000
};
const MAX_CLOUD_ALT_M = 10000;
// 非均匀高度轴：低云 0–2km、中云 2–5km、高云 5–10km 各占 1/3 画布高度。
// 高云的实际范围是 5–10km，与中云在 5–7km 重叠，这里按连续刻度把 5km 以上统一归入高云区。
const CLOUD_BAND_ALTS = [0, 2000, 5000, MAX_CLOUD_ALT_M];
const CLOUD_BAND_FRACS = [0, 1 / 3, 2 / 3, 1];

// 海拔 → 0~1（自下而上的画布占比）
function altToFrac(alt) {
  const a = Math.max(CLOUD_BAND_ALTS[0], Math.min(MAX_CLOUD_ALT_M, alt));
  for (let i = 0; i < CLOUD_BAND_ALTS.length - 1; i++) {
    const a0 = CLOUD_BAND_ALTS[i];
    const a1 = CLOUD_BAND_ALTS[i + 1];
    if (a <= a1) {
      const k = (a - a0) / (a1 - a0);
      return CLOUD_BAND_FRACS[i] + k * (CLOUD_BAND_FRACS[i + 1] - CLOUD_BAND_FRACS[i]);
    }
  }
  return 1;
}

// 0~1 画布占比 → 海拔（altToFrac 的反函数，供逐像素渲染使用）
function fracToAlt(frac) {
  const f = Math.max(0, Math.min(1, frac));
  for (let i = 0; i < CLOUD_BAND_FRACS.length - 1; i++) {
    const f0 = CLOUD_BAND_FRACS[i];
    const f1 = CLOUD_BAND_FRACS[i + 1];
    if (f <= f1) {
      const k = (f - f0) / (f1 - f0);
      return CLOUD_BAND_ALTS[i] + k * (CLOUD_BAND_ALTS[i + 1] - CLOUD_BAND_ALTS[i]);
    }
  }
  return MAX_CLOUD_ALT_M;
}

// 各模式需要标出文字刻度的层（2km / 5km 由三等分分界线单独标注）
const LEVEL_LABELS = {
  ec: { 1000: '110m', 925: '800m', 850: '1.5km', 700: '3km', 300: '9km' },
  gfs: { 1000: '110m', 950: '500m', 900: '1km', 700: '3km', 300: '9km' },
  icon: { 1000: '110m', 950: '500m', 900: '1km', 700: '3km', 300: '9km' }
};

function buildLevels(src) {
  const key = request.LEVELS_HPAS[src] ? src : 'ec';
  const labels = LEVEL_LABELS[key];
  return request.LEVELS_HPAS[key].map(hpa => ({ hpa, alt: ALT_BY_HPA[hpa], albl: labels[hpa] || '' }));
}

const LEVEL_SETS = { ec: buildLevels('ec'), gfs: buildLevels('gfs'), icon: buildLevels('icon') };

function getLevels(src) {
  return (LEVEL_SETS[src] || LEVEL_SETS.ec)
    .filter(level => level.alt <= MAX_CLOUD_ALT_M);
}

const ROWS = [
  { key: 'cloud', name: '总云量' },
  { key: 'cloudHigh', name: '高云' },
  { key: 'cloudMid', name: '中云' },
  { key: 'cloudLow', name: '低云' },
  { key: 'temp', name: '温度℃' },
  { key: 'humid', name: '湿度%' },
  { key: 'precip', name: '降水mm' },
  { key: 'wind', name: '风向' },
  { key: 'vis', name: '能见度km' },
  { key: 'aod', name: '气溶胶' }
];

const CLOUD_ROW_KEY = {
  cloud: 'cloud_cover',
  cloudHigh: 'cloud_cover_high',
  cloudMid: 'cloud_cover_mid',
  cloudLow: 'cloud_cover_low'
};

const SRC_LABELS = { ec: 'ECMWF', gfs: 'GFS', icon: 'ICON' };

// ============ 布局常量（单位 css px） ============
const LABEL_W = 48;
const CLOUD_H = 300;
const CLOUD_PAD_TOP = 8;
const CLOUD_PAD_BOT = 8;
const CLOUD_GAP = 8;
const TIME_H = 30;
const ROW_H = 26;
const PAD_BOT = 8;
const CHART_H = CLOUD_H + CLOUD_GAP + TIME_H + ROWS.length * ROW_H + PAD_BOT;

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WIND_ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

// 温度色标（对应 web 的 TEMP_PALETTE 关键节点）
const TEMP_STOPS = [
  [-30, [80, 163, 247]],
  [0, [141, 252, 204]],
  [20, [110, 200, 130]],
  [30, [255, 211, 92]],
  [50, [251, 75, 75]]
];

// '2026-10-14T00:00' → Date（不用 Date 解析字符串，iOS 更稳）
function parseTime(s) {
  return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16) || 0);
}

function num(arr, i) {
  const v = arr ? arr[i] : null;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function setDash(ctx, arr) {
  try {
    ctx.setLineDash(arr);
  } catch (e) {}
}

function tempColor(t) {
  const v = Math.max(TEMP_STOPS[0][0], Math.min(TEMP_STOPS[TEMP_STOPS.length - 1][0], t));
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    const a = TEMP_STOPS[i], b = TEMP_STOPS[i + 1];
    if (v >= a[0] && v <= b[0]) {
      const k = b[0] === a[0] ? 0 : (v - a[0]) / (b[0] - a[0]);
      const c = a[1].map((x, j) => Math.round(x + (b[1][j] - x) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return '#c0d0e0';
}

Page({
  data: {
    locName: '北京',
    infoSrc: 'ECMWF',
    infoRange: '--',
    loading: false,
    locating: false,
    dataSource: 'ec',
    canvasH: CHART_H
  },

  onLoad() {
    this._raw = null;
    this._canvas = null;
    this._ctx = null;
    this._cssW = 0;
    this._dpr = 1;
    this._visH = 0;
    this._scrollIdx = 0;
    this._fast = false;
    this._drag = null;
    this._busy = false;
    // 定位失败/被拒绝时的默认城市
    this._default = { name: '北京', lat: 39.9042, lon: 116.4074 };
    this._loc = { name: '北京', lat: 39.9042, lon: 116.4074 };
  },

  onReady() {
    this.initCanvas()
      .then(async ok => {
        if (!ok) {
          wx.showToast({ title: '画布初始化失败', icon: 'none' });
          return;
        }
        // 进入页面先自动定位到当前位置
        const located = await this.autoLocate(false);
        if (!located) {
          await this.loadData(this._default.lat, this._default.lon, this._default.name);
        }
      })
      .catch(e => console.error('[page] onReady 异常', e));
  },

  // ============ 定位 / 选址 ============

  // 新版基础库要求先同意隐私协议才能调用位置接口
  ensurePrivacy() {
    return new Promise(resolve => {
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        resolve();
        return;
      }
      wx.requirePrivacyAuthorize({
        success: () => resolve(),
        fail: e => {
          console.warn('[page] 隐私授权未通过', e);
          resolve();
        }
      });
    });
  },

  // 获取当前位置（会弹出微信自带的定位授权提示）
  getLocation() {
    return new Promise(resolve => {
      wx.getLocation({
        type: 'wgs84', // 与 Open-Meteo（WGS84 全球模式）一致
        success: res => resolve({ latitude: res.latitude, longitude: res.longitude }),
        fail: err => {
          console.warn('[page] getLocation 失败', err);
          resolve(null);
        }
      });
    });
  },

  coordLabel(lat, lon) {
    const f = (v, p, n) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? p : n}`;
    return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
  },

  // explicit=true 表示用户主动点了定位按钮，失败时给出更明确的引导
  async autoLocate(explicit) {
    this.setData({ locating: true });
    try {
      await this.ensurePrivacy();
      const pos = await this.getLocation();
      if (!pos) {
        if (explicit) this.promptOpenSetting();
        else wx.showToast({ title: '未授权定位，已显示默认城市', icon: 'none', duration: 2500 });
        return false;
      }
      const name = await request.reverseGeocode(pos.latitude, pos.longitude);
      const label = name || this.coordLabel(pos.latitude, pos.longitude);
      await this.loadData(pos.latitude, pos.longitude, label);
      return true;
    } finally {
      this.setData({ locating: false });
    }
  },

  // 权限被拒后引导用户去设置页打开
  promptOpenSetting() {
    wx.showModal({
      title: '无法定位',
      content: '请在设置中允许「使用我的地理位置」，或直接点击地址栏手动选择地点。',
      confirmText: '去设置',
      success: r => {
        if (r.confirm) wx.openSetting({ success: () => {} });
      }
    });
  },

  // 点击地址栏：打开微信自带的地点选择组件（可搜索、可拖动图钉）
  async onPickLocation() {
    if (this._busy || this.data.locating) return;
    await this.ensurePrivacy();
    wx.chooseLocation({
      latitude: this._loc.lat,
      longitude: this._loc.lon,
      success: res => {
        const name = res.name || res.address || this.coordLabel(res.latitude, res.longitude);
        this.loadData(res.latitude, res.longitude, name);
      },
      fail: err => {
        const msg = (err && err.errMsg) || '';
        // 用户点返回取消不算错误
        if (/cancel/i.test(msg)) return;
        console.warn('[page] chooseLocation 失败', err);
        wx.showToast({ title: '打开地图失败，请检查位置权限', icon: 'none' });
      }
    });
  },

  onRelocate() {
    if (this._busy || this.data.locating) return;
    this.autoLocate(true);
  },

  // 切换数据源（ECMWF ⇄ GFS）：气压层和模型名都不同，需按当前地点重新取数
  onSwitchSource(e) {
    const src = e.currentTarget.dataset.src;
    if (!src || src === this.data.dataSource) return;
    if (this._busy || this.data.locating) return;
    this.loadData(this._loc.lat, this._loc.lon, this._loc.name, src);
  },

  // type="2d" 的画布必须通过节点方式获取上下文，
  // 旧版 wx.createCanvasContext 对它无效（这正是之前画不出东西的原因）。
  initCanvas() {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .in(this)
        .select('#mainCanvas')
        .fields({ node: true, size: true })
        .exec(res => {
          const info = res && res[0];
          if (!info || !info.node || !info.width) {
            console.error('[page] 未取到 canvas 节点', res);
            resolve(false);
            return;
          }
          let dpr = 1;
          try {
            const win = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = win.pixelRatio || 1;
          } catch (e) {
            console.warn('[page] 获取 pixelRatio 失败，按 1 处理', e);
          }
          const canvas = info.node;
          canvas.width = Math.round(info.width * dpr);
          canvas.height = Math.round(info.height * dpr);
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          this._canvas = canvas;
          this._ctx = ctx;
          this._cssW = info.width;
          this._dpr = dpr;
          console.log('[page] canvas ready', info.width, info.height, dpr);
          resolve(true);
        });
    });
  },

  // ============ 横向拖动查看更长时间范围 ============
  onCanvasTouchStart(e) {
    if (!this._raw || !e.touches || !e.touches.length) return;
    this._drag = { x: e.touches[0].clientX, startIdx: this._scrollIdx };
  },

  onCanvasTouchMove(e) {
    if (!this._raw || !this._drag || !e.touches || !e.touches.length) return;
    const visH = this._visH || 1;
    const totalT = this._raw.hourly.time.length;
    const delta = Math.round((this._drag.x - e.touches[0].clientX) / 28);
    const next = Math.max(0, Math.min(Math.max(0, totalT - visH), this._drag.startIdx + delta));
    if (next === this._scrollIdx) return;
    this._scrollIdx = next;
    this._fast = true;
    this.render();
  },

  onCanvasTouchEnd() {
    if (!this._drag) return;
    this._drag = null;
    if (this._fast) {
      this._fast = false;
      this.render();
    }
  },

  async loadData(lat, lon, name, src) {
    if (this._busy) return;
    const model = request.LEVELS_HPAS[src] ? src : this.data.dataSource;
    this._busy = true;
    this.setData({ loading: true });
    try {
      const raw = await request.fetchData(lat, lon, model);
      this.applyData(raw, lat, lon, name, model);
    } catch (e) {
      console.error('[page] 加载失败', e);
      wx.showToast({ title: '加载失败，请检查网络/域名白名单', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ loading: false });
    }
  },

  applyData(raw, lat, lon, name, model) {
    if (!raw || !raw.hourly || !raw.hourly.time || !raw.hourly.time.length) {
      throw new Error('数据为空');
    }
    const src = request.LEVELS_HPAS[model] ? model : 'ec';
    this._raw = raw;
    const label = name || this.data.locName;
    this._loc = { lat, lon, name: label };
    // 把当前选择发布到全局状态，供「火烧云」页复用（不改变本页任何逻辑）
    const app = getApp();
    const g = app && app.globalData;
    if (g) {
      g.locName = label;
      g.locLat = lat;
      g.locLon = lon;
      g.dataSource = src;
    }
    // 接口用 forecast_hours=72 返回「当地当前整点 ~ +71 小时」，所以直接从头开始渲染
    this._scrollIdx = 0;
    const times = raw.hourly.time;
    const a = parseTime(times[0]);
    const b = parseTime(times[times.length - 1]);
    const fmt = d => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}时`;
    this.setData({
      locName: label,
      dataSource: src,
      infoRange: `${fmt(a)}~${fmt(b)}`,
      infoSrc: SRC_LABELS[src] || 'ECMWF'
    });
    this.render();
  },

  // ============ 渲染入口 ============
  render() {
    const ctx = this._ctx;
    const raw = this._raw;
    if (!ctx || !raw) return;

    const dpr = this._dpr;
    const w = this._cssW;
    const h = CHART_H;
    const times = raw.hourly.time;
    const totalT = times.length;
    const levels = getLevels(this.data.dataSource);
    const nL = levels.length;

    const si0 = this._scrollIdx || 0;
    const visH = Math.max(6, Math.min(totalT, Math.floor((w - LABEL_W) / 26)));
    const maxScroll = Math.max(0, totalT - visH);
    const si = Math.max(0, Math.min(si0, maxScroll));
    this._scrollIdx = si;
    this._visH = visH;
    const colW = (w - LABEL_W) / visH;
    const dx = LABEL_W;
    const drawW = colW * visH;
    const cloudInnerH = CLOUD_H - CLOUD_PAD_TOP - CLOUD_PAD_BOT;
    const altY = alt => CLOUD_PAD_TOP + cloudInnerH * (1 - altToFrac(alt));
    const lvlY = li => altY(levels[li].alt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(0, 0, w, h);

    // ---- 云图剖面 ----
    const T = Math.min(visH, totalT - si);
    const grid = this.buildCloudGrid(raw, levels, si, visH);
    if (this._fast) {
      // 拖动中用色块快速重绘，松手后再出高清图
      this.drawCloudFieldFallback(ctx, grid, levels, T, dx, drawW, cloudInnerH);
    } else {
      this.drawCloudField(ctx, grid, levels, T, dx, drawW, cloudInnerH, dpr);
    }

    // ---- 高度刻度 ----
    ctx.save();
    ctx.fillStyle = '#667a90';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let li = 0; li < nL; li++) {
      if (levels[li].albl) ctx.fillText(levels[li].albl, LABEL_W - 6, lvlY(li));
    }
    // 三等分分界线刻度
    ctx.fillText('2km', LABEL_W - 6, altY(2000));
    ctx.fillText('5km', LABEL_W - 6, altY(5000));
    ctx.fillText(`${MAX_CLOUD_ALT_M / 1000}km`, LABEL_W - 6, CLOUD_PAD_TOP);
    ctx.fillText('0m', LABEL_W - 6, CLOUD_H + 4);
    ctx.restore();

    // ---- 低/中/高云分界参考线（2km、5km 正好落在三等分处）----
    const hlLine = (alt, color) => {
      const y = altY(alt);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      setDash(ctx, [6, 4]);
      ctx.beginPath();
      ctx.moveTo(dx, y);
      ctx.lineTo(dx + drawW, y);
      ctx.stroke();
      ctx.restore();
    };
    hlLine(2000, 'rgba(120,180,220,0.35)');
    hlLine(5000, 'rgba(190,155,220,0.35)');

    // ---- 时间轴 ----
    const timeY = CLOUD_H + CLOUD_GAP;
    ctx.fillStyle = '#101830';
    ctx.fillRect(0, timeY, w, TIME_H);
    let lastDay = '';
    for (let vi = 0; vi < visH; vi++) {
      const ti = si + vi;
      if (ti >= totalT) break;
      const d = parseTime(times[ti]);
      const x = dx + vi * colW;
      const cx = x + colW / 2;
      const dayKey = `${d.getMonth() + 1}/${d.getDate()}`;
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        ctx.fillStyle = '#aac8e0';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${dayKey} ${DAY_NAMES[d.getDay()]}`, x + 2, timeY + 9);
        if (vi > 0) {
          ctx.strokeStyle = 'rgba(100,140,180,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, timeY + 2);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      const hh = d.getHours();
      ctx.fillStyle = hh === 0 ? '#f0c060' : hh % 3 === 0 ? '#8899bb' : '#556680';
      ctx.font = hh % 3 === 0 ? 'bold 9px sans-serif' : '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(hh).padStart(2, '0'), cx, timeY + 21);
    }

    // ---- “现在”参考线 ----
    // 数据第 0 项就是当地的当前整点，所以「现在」恒在索引 0 处，
    // 用索引换算可避免异地城市时的时区偏差。
    const nowX = dx + (0 - si) * colW;
    if (nowX >= dx - colW && nowX <= dx + drawW) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,80,80,0.55)';
      ctx.lineWidth = 1.5;
      setDash(ctx, [3, 3]);
      ctx.beginPath();
      ctx.moveTo(nowX, 0);
      ctx.lineTo(nowX, h);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#ff6666';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('现在', Math.min(nowX + 3, w - 24), CLOUD_H - 6);
    }

    // ---- 要素行 ----
    const dataY0 = timeY + TIME_H;
    const s = raw.hourly_surface || raw.hourly;
    for (let ri = 0; ri < ROWS.length; ri++) {
      const row = ROWS[ri];
      const y0 = dataY0 + ri * ROW_H;
      ctx.fillStyle = ri % 2 === 0 ? 'rgba(14,22,38,0.9)' : 'rgba(18,28,46,0.9)';
      ctx.fillRect(0, y0, w, ROW_H);

      ctx.fillStyle = '#667a90';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.name, 4, y0 + ROW_H / 2);

      for (let vi = 0; vi < visH; vi++) {
        const ti = si + vi;
        if (ti >= totalT) break;
        const x = dx + vi * colW;
        const cx = x + colW / 2;

        // 云量行：色块（不写字，列宽不够）
        if (CLOUD_ROW_KEY[row.key]) {
          const cv = num(raw.hourly[CLOUD_ROW_KEY[row.key]], ti);
          if (cv != null) {
            const t = cv / 100;
            const r = Math.round(40 + t * 195);
            const g = Math.round(80 + t * 170);
            const b = Math.round(140 + t * 110);
            ctx.fillStyle = `rgba(${r},${g},${b},0.55)`;
            ctx.fillRect(x, y0 + 1, colW, ROW_H - 2);
          }
          continue;
        }

        let text = '·';
        let color = '#334455';
        let bar = -1;
        if (row.key === 'temp') {
          const v = num(s && s.temperature_2m, ti);
          if (v != null) { text = String(Math.round(v)); color = tempColor(v); }
        } else if (row.key === 'humid') {
          const v = num(s && s.relative_humidity_2m, ti);
          if (v != null) { text = String(Math.round(v)); color = '#80c0e8'; }
        } else if (row.key === 'precip') {
          const v = num(s && s.precipitation, ti);
          if (v != null && v > 0) { bar = Math.max(0, Math.min(1, v / 5)); text = v.toFixed(1); color = '#5098d0'; }
        } else if (row.key === 'wind') {
          const d = num(s && s.wind_direction_10m, ti);
          const ws = num(s && s.wind_speed_10m, ti);
          if (d != null) { text = WIND_ARROWS[Math.round(d / 45) % 8]; color = ws != null && ws > 10 ? '#ffc860' : '#a0b8d0'; }
        } else if (row.key === 'vis') {
          const v = num(s && s.visibility, ti);
          if (v != null) {
            text = String(Math.round(v / 1000));
            color = v > 20000 ? '#a0dca0' : v > 10000 ? '#c8c8a0' : '#dca08c';
          }
        } else if (row.key === 'aod') {
          const v = num(s && s.aerosol_optical_depth, ti);
          if (v != null) {
            text = v.toFixed(2);
            color = v > 0.8 ? '#e0a06c' : v > 0.3 ? '#c8c0a0' : '#a0b8d0';
          }
        }

        if (bar >= 0) {
          const barH = bar * (ROW_H - 8);
          ctx.fillStyle = 'rgba(80,152,208,0.35)';
          ctx.fillRect(cx - 2, y0 + ROW_H - 4 - barH, 4, barH);
        }
        ctx.fillStyle = color;
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, y0 + ROW_H / 2);
      }
    }
  },

  // 云量网格：grid[li][vi] = 0~1，取本层与上一层的较大值（与 web 版一致）
  buildCloudGrid(raw, levels, si, visH) {
    const nL = levels.length;
    const grid = [];
    for (let li = 0; li < nL; li++) {
      const cur = raw.hourly[`cloud_cover_${levels[li].hpa}hPa`];
      const up = raw.hourly[`cloud_cover_${levels[Math.min(li + 1, nL - 1)].hpa}hPa`];
      const row = new Float32Array(visH);
      for (let vi = 0; vi < visH; vi++) {
        const ti = si + vi;
        const a = num(cur, ti);
        const b = num(up, ti);
        row[vi] = Math.max(a == null ? 0 : a, b == null ? 0 : b) / 100;
      }
      grid.push(row);
    }
    return grid;
  },

  // 用 ImageData 在设备像素上做双线性插值后直接写入画布，得到与 web 版一致的云雾质感
  drawCloudField(ctx, grid, levels, T, dx, drawW, cloudInnerH, dpr) {
    const nL = levels.length;
    const imgW = Math.max(1, Math.round(drawW * dpr));
    const imgH = Math.max(1, Math.round(cloudInnerH * dpr));
    let img = null;
    try {
      img = ctx.createImageData(imgW, imgH);
    } catch (e) {
      console.warn('[page] createImageData 不可用，改用色块绘制', e);
    }
    if (!img || !img.data) {
      this.drawCloudFieldFallback(ctx, grid, levels, T, dx, drawW, cloudInnerH);
      return;
    }

    const data = img.data;
    const maxL = nL - 1;
    const maxT = T - 1;
    for (let py = 0; py < imgH; py++) {
      const altitude = fracToAlt(1 - (py + 0.5) / imgH);
      let l0 = 0;
      while (l0 < maxL - 1 && levels[l0 + 1].alt < altitude) l0++;
      const l1 = Math.min(l0 + 1, maxL);
      const altitudeSpan = levels[l1].alt - levels[l0].alt;
      const ly = altitude <= levels[0].alt || l0 === l1 || altitudeSpan <= 0
        ? 0
        : Math.min(1, (altitude - levels[l0].alt) / altitudeSpan);
      const rowA = grid[l0];
      const rowB = grid[l1];
      const base = py * imgW * 4;
      for (let px = 0; px < imgW; px++) {
        const xData = ((px + 0.5) / imgW) * maxT;
        const t0 = Math.max(0, Math.min(maxT, Math.floor(xData)));
        const t1 = Math.min(t0 + 1, maxT);
        const tx = t0 === t1 ? 0 : xData - t0;
        const v0 = rowA[t0] + (rowA[t1] - rowA[t0]) * tx;
        const v1 = rowB[t0] + (rowB[t1] - rowB[t0]) * tx;
        const v = v0 + (v1 - v0) * ly;

        const idx = base + px * 4;
        const q = Math.max(0, Math.min(159, Math.floor(v * 160)));
        const J = Math.floor((q + 12) / 16) * 24;
        if (J > 10) {
          data[idx] = 232;
          data[idx + 1] = 240;
          data[idx + 2] = 250;
          data[idx + 3] = Math.round(Math.max(30, Math.min(210, (J / 200) * 210)));
        } else {
          data[idx + 3] = 0;
        }
      }
    }

    // putImageData 不受当前缩放矩阵影响，所以按设备像素坐标写入
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, Math.round(dx * dpr), Math.round(CLOUD_PAD_TOP * dpr));
    ctx.restore();
  },

  // ImageData 不可用时的兜底：逐层色块
  drawCloudFieldFallback(ctx, grid, levels, T, dx, drawW, cloudInnerH) {
    const nL = levels.length;
    const colW = drawW / T;
    for (let li = 0; li < nL; li++) {
      const lowerAlt = li === 0 ? 0 : (levels[li - 1].alt + levels[li].alt) / 2;
      const upperAlt = li === nL - 1
        ? MAX_CLOUD_ALT_M
        : Math.min(MAX_CLOUD_ALT_M, (levels[li].alt + levels[li + 1].alt) / 2);
      const yTop = CLOUD_PAD_TOP + cloudInnerH * (1 - altToFrac(upperAlt));
      const yBot = CLOUD_PAD_TOP + cloudInnerH * (1 - altToFrac(lowerAlt));
      for (let vi = 0; vi < T; vi++) {
        const v = grid[li][vi];
        if (v < 0.025) continue;
        ctx.fillStyle = `rgba(232,240,250,${Math.max(0.12, Math.min(0.82, v * 0.82)).toFixed(3)})`;
        ctx.fillRect(dx + vi * colW, yTop, colW + 0.5, Math.max(0, yBot - yTop));
      }
    }
  }
});
