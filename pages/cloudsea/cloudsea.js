// 云海预测页
// 地点复用「云图」页；气象数据源由本页独立选择（ECMWF / GFS / ICON）。
const request = require('../../utils/request.js');
const seacloud = require('../../utils/seacloud.js');

const CACHE_TTL = 10 * 60 * 1000; // 同一地点/数据源 10 分钟内不重复取数
const DEFAULT_LOC = { name: '北京', lat: 39.9042, lon: 116.4074 };

// '2026-11-08T16:00' → '11/8 16时'
function timeLabel(s) {
  const t = String(s || '');
  if (t.length < 13) return t;
  const M = +t.slice(5, 7);
  const D = +t.slice(8, 10);
  const hh = t.slice(11, 13);
  return `${M}/${D} ${hh}时`;
}

// '2026-11-08T16:00' → '16'（柱状图/画布下方短标签，仅显示小时数字）
function shortTimeLabel(s) {
  const t = String(s || '');
  if (t.length < 13) return t;
  return t.slice(11, 13);
}

Page({
  data: {
    loading: false,
    error: '',
    locName: '--',
    dataSource: 'ec',
    elevation: '--',
    hasResult: false,
    best24h: null,
    bars: [],
    factors: [],
    cloudMin: 5
  },

  onLoad() {
    this._sel = null;
    this._raw = null;
    this._elevation = null;
    this._fetchedAt = 0;
    this._seq = 0;
    this._altCanvas = null;
    this._altCtx = null;
    this._altW = 0;
    this._altH = 0;
    this._altDpr = 1;
    this._altProfile = null;
  },

  onShow() {
    this.refresh(false);
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  onSwitchSource(e) {
    const src = e.currentTarget.dataset.src;
    if ((src !== 'ec' && src !== 'gfs' && src !== 'icon') || src === this.data.dataSource) return;
    this.setData({ dataSource: src, error: '' });
    this.refresh(true);
  },

  // 云层含量滑块：拖动中更新提示，松手后按阈值重绘云层
  onCloudMinChanging(e) {
    const v = Number(e.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ cloudMin: v });
  },

  onCloudMinChange(e) {
    const v = Number(e.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ cloudMin: v });
    this.renderAltitudeChart();
  },

  // 与火烧云页一致：从全局状态读取「云图」页选定的地点
  resolveSelection() {
    const app = getApp();
    const g = (app && app.globalData) || {};
    let name = g.locName || '';
    let lat = Number(g.locLat);
    let lon = Number(g.locLon);
    const src = this.data.dataSource;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      lat = DEFAULT_LOC.lat;
      lon = DEFAULT_LOC.lon;
      name = name || DEFAULT_LOC.name;
    }
    return { lat, lon, name: name || DEFAULT_LOC.name, src };
  },

  async refresh(force) {
    const sel = this.resolveSelection();
    const same = this._sel
      && this._sel.lat === sel.lat && this._sel.lon === sel.lon && this._sel.src === sel.src;
    if (!force && same && this._raw && this._elevation != null && (Date.now() - this._fetchedAt) < CACHE_TTL) {
      this.applyData(this._raw, sel, this._elevation);
      this.setData({ error: '' });
      return;
    }

    const seq = ++this._seq;
    this.setData({ loading: true, error: '', locName: sel.name });

    const [elevation, raw] = await Promise.all([
      request.fetchElevation(sel.lat, sel.lon),
      request.fetchSeaCloudData(sel.lat, sel.lon, sel.src)
    ]);

    // 快速切页时丢弃过期响应
    if (seq !== this._seq) return;

    if (!raw || !raw.hourly) {
      this.setData({ loading: false, error: '数据获取失败，请检查网络或 request 合法域名' });
      return;
    }

    this._raw = raw;
    this._sel = sel;
    this._elevation = elevation;
    this._fetchedAt = Date.now();

    this.applyData(raw, sel, elevation);
    this.setData({ loading: false });
  },

  applyData(raw, sel, elevation) {
    if (elevation == null || !Number.isFinite(elevation)) {
      this.setData({
        hasResult: false,
        elevation: '--',
        best24h: null,
        bars: [],
        factors: [],
        error: '海拔数据获取失败，无法预测云海（点击重试）'
      });
      return;
    }

    const levels = raw._levels || request.LEVELS_HPAS[sel.src] || request.LEVELS_HPAS.ec;
    const r = seacloud.evaluate(raw.hourly, levels, elevation);

    const series = r.series || [];
    const horizon = Math.min(24, series.length);
    const bars = [];
    for (let i = 0; i < horizon; i++) {
      const s = series[i];
      bars.push({
        key: i,
        probPct: s.probPct,
        time: shortTimeLabel(s.time),
        level: s.level
      });
    }

    const cur = r.current || {};
    const best = r.best24h || cur;

    const factors = best.hasCloud ? [
      { k: '云顶高度', v: `${best.cloudTop} m` },
      { k: '云底高度', v: `${best.cloudBase} m` },
      { k: '云顶与观测点高差', v: `${best.delta} m` },
      { k: '云段最大云量', v: `${best.cloudMax}%` },
      { k: '逆温强度', v: `${best.inversion} ℃` },
      { k: '近地面湿度', v: `${best.rh0}%` },
      { k: '地面风速', v: `${best.wind} m/s` }
    ] : [
      { k: '当前', v: '近地面无云，暂不具备云海条件' }
    ];

    this._altProfile = seacloud.buildAltitudeProfile(raw.hourly, levels, elevation, 24);
    // canvas 节点在 wx:else 块重渲染时会被重建，强制下次重新测量/获取上下文
    this._altCtx = null;
    this._altCanvas = null;
    this._altW = 0;

    this.setData({
      hasResult: true,
      elevation: elevation == null ? '--' : `${Math.round(elevation)} m`,
      best24h: {
        probPct: best.probPct || 0,
        level: best.level || '—',
        time: timeLabel(best.time)
      },
      bars,
      factors
    });

    // 等 canvas 挂载到 DOM 后再测量并绘制
    setTimeout(() => this.renderAltitudeChart(), 60);
  },

  // ============ 海拔-云层高度剖面图 ============

  initAltitudeCanvas() {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .in(this)
        .select('#altCanvas')
        .fields({ node: true, size: true })
        .exec(res => {
          const info = res && res[0];
          if (!info || !info.node || !info.width) {
            console.warn('[cloudsea] 未取到 altCanvas 节点', res);
            resolve(false);
            return;
          }
          let dpr = 1;
          try {
            const win = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = win.pixelRatio || 1;
          } catch (e) {
            console.warn('[cloudsea] 获取 pixelRatio 失败', e);
          }
          const canvas = info.node;
          canvas.width = Math.round(info.width * dpr);
          canvas.height = Math.round(info.height * dpr);
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          this._altCanvas = canvas;
          this._altCtx = ctx;
          this._altW = info.width;
          this._altH = info.height;
          this._altDpr = dpr;
          resolve(true);
        });
    });
  },

  async renderAltitudeChart() {
    const profile = this._altProfile;
    if (!profile) return;

    if (!this._altCtx || !this._altW) {
      const ok = await this.initAltitudeCanvas();
      if (!ok) return;
    }

    const ctx = this._altCtx;
    const W = this._altW;
    const H = this._altH;
    const dpr = this._altDpr;
    const { elevation, ceiling, levelAlts, grid, columns } = profile;
    // 云层含量阈值（0~1）：低于该值的云不显示
    const minCover = Math.max(0, Math.min(1, Number(this.data.cloudMin) / 100));

    const PAD_L = 46;
    const PAD_R = 6;
    const PAD_T = 10;
    const PAD_B = 20;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const yOf = alt => PAD_T + plotH * (1 - alt / ceiling);
    const n = Math.max(1, columns.length);
    const colW = plotW / n;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(0, 0, W, H);

    // ---- 云层（ImageData 双线性插值，与「云图」页一致的云雾质感）----
    const imgW = Math.max(1, Math.round(plotW * dpr));
    const imgH = Math.max(1, Math.round(plotH * dpr));
    let img = null;
    try { img = ctx.createImageData(imgW, imgH); } catch (e) {
      console.warn('[cloudsea] createImageData 不可用，改用色块绘制', e);
    }

    if (img && img.data) {
      const data = img.data;
      const maxL = levelAlts.length - 1;
      const maxT = n - 1;
      for (let py = 0; py < imgH; py++) {
        const altitude = ceiling * (1 - (py + 0.5) / imgH);
        let l0 = 0;
        while (l0 < maxL - 1 && levelAlts[l0 + 1] < altitude) l0++;
        const l1 = Math.min(l0 + 1, maxL);
        const altSpan = levelAlts[l1] - levelAlts[l0];
        const ly = altSpan <= 0 ? 0 : Math.min(1, Math.max(0, (altitude - levelAlts[l0]) / altSpan));
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
          if (v < minCover) {
            data[idx + 3] = 0;
            continue;
          }
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
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(img, Math.round(PAD_L * dpr), Math.round(PAD_T * dpr));
      ctx.restore();
    } else {
      // 兜底：逐层色块
      for (let li = 0; li < levelAlts.length; li++) {
        const lowerAlt = li === 0 ? 0 : (levelAlts[li - 1] + levelAlts[li]) / 2;
        const upperAlt = li === levelAlts.length - 1 ? ceiling : Math.min(ceiling, (levelAlts[li] + levelAlts[li + 1]) / 2);
        const yTop = yOf(upperAlt);
        const yBot = yOf(Math.max(0, lowerAlt));
        for (let i = 0; i < n; i++) {
          const v = grid[li][i];
          if (v < minCover || v < 0.05) continue;
          ctx.fillStyle = `rgba(232,240,250,${Math.max(0.12, Math.min(0.82, v * 0.82)).toFixed(3)})`;
          ctx.fillRect(PAD_L + i * colW, yTop, colW + 0.5, Math.max(0, yBot - yTop));
        }
      }
    }

    // ---- 海拔网格线与刻度（500m 间隔）----
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = 500;
    for (let alt = 0; alt <= ceiling; alt += step) {
      const y = yOf(alt);
      ctx.fillStyle = '#556680';
      ctx.fillText(alt + 'm', PAD_L - 4, y);
      ctx.strokeStyle = 'rgba(90,120,160,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(W - PAD_R, y);
      ctx.stroke();
    }

    // ---- 观测点海拔参考线（橙色虚线）----
    const yEl = yOf(elevation);
    ctx.strokeStyle = '#f0a63c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(PAD_L, yEl);
    ctx.lineTo(W - PAD_R, yEl);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f0a63c';
    ctx.textAlign = 'left';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('观测点海拔 ' + Math.round(elevation) + 'm', PAD_L + 4, yEl - 5);

    // ---- 时间刻度（每 3 小时 + 末位）----
    ctx.fillStyle = '#667a90';
    ctx.textAlign = 'center';
    ctx.font = '8px sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      if (i % 3 === 0 || i === n - 1) {
        ctx.fillText(shortTimeLabel((columns[i] && columns[i].time) || ''), PAD_L + i * colW + colW / 2, H - PAD_B + 12);
      }
    }
  }
});
