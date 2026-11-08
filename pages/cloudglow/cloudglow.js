// 火烧云（朝霞 / 晚霞）预测页
// 地点复用「云图」页；气象数据源由本页独立选择。
const request = require('../../utils/request.js');
const solar = require('../../utils/solar.js');
const afterglow = require('../../utils/afterglow.js');

// Open-Meteo 逐小时要素（能见度单位为米）
const HOURLY = [
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation',
  'wind_speed_10m', 'wind_direction_10m', 'visibility'
].join(',');

const FORECAST_DAYS = 3;
const PAST_DAYS = 1;              // 回看 1 天，供「趋势 / 前 1 小时降水」使用
const CACHE_TTL = 10 * 60 * 1000; // 同一地点/数据源 10 分钟内不重复取数
const DEFAULT_LOC = { name: '北京', lat: 39.9042, lon: 116.4074 };

function getJSON(url) {
  return new Promise(resolve => {
    wx.request({
      url,
      success: r => resolve(r && r.statusCode === 200 ? r.data : null),
      fail: err => {
        console.warn('[afterglow] 请求失败（请检查 request 合法域名）', url, err);
        resolve(null);
      }
    });
  });
}

// Open-Meteo 的 time 为站点当地墙钟，如 "2026-10-14T06:00"，补全后按 UTC 解析，
// 这样得到的是「墙钟毫秒」，与 Date.now()+utc_offset_seconds*1000 可直接比较。
function wallMs(timeStr) {
  const s = String(timeStr);
  return Date.parse((s.length === 16 ? s + ':00' : s) + 'Z');
}

const UNIT = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct2f = v => Math.max(0, Math.min(1, UNIT(v) / 100));
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

function fmtPct(x) {
  return Math.round(x * 100) + '%';
}

function dayLabel(eventWallMs, nowWallMs) {
  const a = Date.parse(solar.wallDateStr(eventWallMs) + 'T00:00:00Z');
  const b = Date.parse(solar.wallDateStr(nowWallMs) + 'T00:00:00Z');
  const diff = Math.round((a - b) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  const d = new Date(a);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

Page({
  data: {
    loading: false,
    error: '',
    locName: '--',
    dataSource: 'ec',
    selectedDay: 'today',
    sections: []
  },

  onLoad() {
    this._sel = null;
    this._raw = null;
    this._fetchedAt = 0;
    this._seq = 0;
    // 还没手动点过「今日/明日」时，按今日晚霞是否已过自动决定默认日期
    this._dayAuto = true;
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

  // ============ 共享状态：地点 ============

  // 云图页取数成功后写入地点；这里只读不写，云图页的地图/剖面逻辑不受影响。
  resolveSelection() {
    const app = getApp();
    const g = (app && app.globalData) || {};
    let name = g.locName || '';
    let lat = Number(g.locLat);
    let lon = Number(g.locLon);
    const src = this.data.dataSource;

    // 用户还没进过「云图」页时，app.js 的默认地点（或本页兜底）生效
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      lat = DEFAULT_LOC.lat;
      lon = DEFAULT_LOC.lon;
      name = name || DEFAULT_LOC.name;
    }
    return { lat, lon, name: name || DEFAULT_LOC.name, src };
  },

  // ============ 取数 ============

  async refresh(force) {
    const sel = this.resolveSelection();
    const same = this._sel
      && this._sel.lat === sel.lat && this._sel.lon === sel.lon && this._sel.src === sel.src;
    if (!force && same && this._raw && (Date.now() - this._fetchedAt) < CACHE_TTL) {
      try {
        this.applyData(this._raw, sel, this.data.selectedDay);
        this.setData({ error: '' });
      } catch (e) {
        this.setData({ sections: [], error: (e && e.message) || '数据解析失败' });
      }
      return;
    }

    const seq = ++this._seq;
    this.setData({
      loading: true,
      error: '',
      locName: sel.name
    });

    const model = request.API_MODEL[sel.src] || request.API_MODEL.ec;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${sel.lat}&longitude=${sel.lon}`
      + `&hourly=${HOURLY}&models=${model}&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`
      + `&timezone=auto&_=${Date.now()}`;

    let raw = null;
    try {
      raw = await getJSON(url);
    } catch (e) {
      console.warn('[afterglow] 取数异常', e);
    }
    // 快速切页时丢弃过期响应
    if (seq !== this._seq) return;

    if (!raw || !raw.hourly || !raw.hourly.time || !raw.hourly.time.length) {
      this.setData({ loading: false, error: '数据获取失败，请检查网络或 request 合法域名' });
      return;
    }

    this._raw = raw;
    this._sel = sel;
    this._fetchedAt = Date.now();

    try {
      this.applyData(raw, sel, this.data.selectedDay);
      this.setData({ loading: false });
    } catch (e) {
      console.error('[afterglow] 计算失败', e);
      // 让下一次 onShow / 下拉刷新真正重试，而不是被缓存挡住
      this._raw = null;
      this._fetchedAt = 0;
      this.setData({ loading: false, error: (e && e.message) || '数据解析失败' });
    }
  },

  // ============ 计算与渲染 ============

  selectDay(e) {
    const selectedDay = e.currentTarget.dataset.day;
    // 手动选择后不再自动切换
    this._dayAuto = false;
    if (selectedDay === this.data.selectedDay) return;

    this.setData({ selectedDay, error: '' });
    if (!this._raw || !this._sel || this.data.loading) return;

    try {
      this.applyData(this._raw, this._sel, selectedDay);
    } catch (err) {
      console.error('[afterglow] 计算失败', err);
      this.setData({ sections: [], error: (err && err.message) || '数据解析失败' });
    }
  },

  // 点击朝霞 / 晚霞卡片 → 打开该事件时刻的光线路径云图
  openSkyMap(e) {
    const kind = e.currentTarget.dataset.kind;
    const sel = this._sel || this.resolveSelection();
    const sec = (this.data.sections || []).find(s => s.key === kind);
    if (!sec || !Number.isFinite(sec.eventWallMs)) return;

    const q = [
      `lat=${sel.lat}`,
      `lon=${sel.lon}`,
      `name=${encodeURIComponent(sel.name || '')}`,
      `kind=${kind}`,
      `t=${sec.eventWallMs}`,
      `az=${sec.sunAzimuth}`,
      `el=${sec.sunElevation}`,
      `src=${this.data.dataSource}`
    ].join('&');

    wx.navigateTo({
      url: `/pages/skymap/skymap?${q}`,
      fail: err => {
        console.warn('[afterglow] 打开光线路径云图失败', err);
        wx.showToast({ title: '打开云图失败', icon: 'none' });
      }
    });
  },

  applyData(raw, sel, selectedDay) {
    const h = raw.hourly;
    const tzSec = Number(raw.utc_offset_seconds) || 0;
    const times = h.time.map(wallMs);
    if (!times.length) throw new Error('时间序列为空');

    const nowWall = Date.now() + tzSec * 1000;
    const day = this.resolveDay(selectedDay, nowWall, tzSec, sel);
    if (day !== selectedDay) this.setData({ selectedDay: day });
    const dayOffset = day === 'tomorrow' ? 1 : 0;
    const events = this.findDayEvents(times, tzSec, sel.lat, sel.lon, nowWall, dayOffset);

    const sections = [];
    if (events.dawn) sections.push(this.buildSection('dawn', h, times, events.dawn, tzSec, nowWall, sel));
    if (events.dusk) sections.push(this.buildSection('dusk', h, times, events.dusk, tzSec, nowWall, sel));

    if (!sections.length) {
      this.setData({ sections: [] });
      throw new Error(events.polar
        ? '所选日期该地点处于极昼或极夜，没有日出/日落'
        : '所选日期没有可用的日出/日落数据');
    }

    this.setData({ sections });
  },

  // 默认日期：今日晚霞已过 → 明日；尚未到今日晚霞 → 今日。
  // 用户手动点过「今日/明日」后不再自动切换（_dayAuto 为 false）。
  resolveDay(selectedDay, nowWall, tzSec, sel) {
    if (!this._dayAuto) return selectedDay;
    const today = solar.sunEventsForDate(solar.wallDateStr(nowWall), sel.lat, sel.lon, tzSec);
    // 极昼/极夜没有日落时刻，保持原有选择
    if (today.polar || !Number.isFinite(today.setWallMs)) return selectedDay;
    return nowWall > today.setWallMs ? 'tomorrow' : 'today';
  },

  // 取所选当地日期的日出与日落，不因事件已过去而跳过。
  findDayEvents(times, tzSec, lat, lon, nowWall, dayOffset) {
    const out = { dawn: null, dusk: null, polar: false };
    const base = Date.parse(solar.wallDateStr(nowWall) + 'T00:00:00Z');
    const dateStr = solar.wallDateStr(base + dayOffset * 86400000);
    const ev = solar.sunEventsForDate(dateStr, lat, lon, tzSec);
    if (ev.polar) {
      out.polar = true;
      return out;
    }
    out.dawn = ev.riseWallMs;
    out.dusk = ev.setWallMs;

    const lo = times[0];
    const hi = times[times.length - 1];
    if (out.dawn !== null && (out.dawn < lo || out.dawn > hi)) out.dawn = null;
    if (out.dusk !== null && (out.dusk < lo || out.dusk > hi)) out.dusk = null;
    return out;
  },

  buildSection(kind, h, times, eventWallMs, tzSec, nowWall, sel) {
    const idx = this.nearestIndex(times, eventWallMs);
    const at = key => (h[key] && h[key].length ? h[key][idx] : null);

    const cloudTotal = pct2f(at('cloud_cover'));
    const cloudHigh = pct2f(at('cloud_cover_high'));
    const cloudMid = pct2f(at('cloud_cover_mid'));
    const cloudLow = pct2f(at('cloud_cover_low'));

    const tempC = UNIT(at('temperature_2m'));
    const rhPct = clamp(UNIT(at('relative_humidity_2m')), 0, 100);
    const dewC = at('dew_point_2m');
    const spreadC = dewC === null
      ? Math.max(0, tempC - (100 - rhPct) / 5)
      : Math.max(0, tempC - UNIT(dewC));

    // 能见度：Open-Meteo 单位为米；0/缺失按「中性」处理，避免误判为浓雾
    const visRaw = at('visibility');
    const visVal = UNIT(visRaw);
    const visKm = visRaw === null || !(visVal > 0)
      ? 20
      : clamp(visVal / 1000, 0.1, 100);

    const precipNow = Math.max(0, UNIT(at('precipitation')));
    const precipPrev = idx > 0 && h.precipitation ? Math.max(0, UNIT(h.precipitation[idx - 1])) : 0;

    const windDirDeg = h.wind_direction_10m && h.wind_direction_10m.length
      ? ((UNIT(h.wind_direction_10m[idx]) % 360) + 360) % 360
      : 0;

    const prevTotal = idx > 0 && h.cloud_cover ? pct2f(h.cloud_cover[idx - 1]) : cloudTotal;
    const deltaCloudTotal = cloudTotal - prevTotal;

    const sunUtcMs = eventWallMs - tzSec * 1000;
    const pos = solar.sunPosition(sunUtcMs, sel.lat, sel.lon);

    const res = afterglow.evaluate({
      cloudTotal,
      cloudHigh,
      cloudMid,
      cloudLow,
      tempC,
      rhPct,
      spreadC,
      visKm,
      precipNow,
      precipPrev,
      windDirDeg,
      sunAzimuthDeg: pos.azimuth,
      deltaCloudTotal
    });

    const m = res.detail.model;
    const g = res.detail.gates;
    const isDawn = kind === 'dawn';
    const glowDuration = Math.round(m.glowMin);
    const expectedStart = isDawn ? eventWallMs - glowDuration * 60000 : eventWallMs;
    const expectedEnd = isDawn ? eventWallMs : eventWallMs + glowDuration * 60000;

    return {
      key: kind,
      tone: kind,
      eventWallMs: Math.round(eventWallMs),
      sunAzimuth: Math.round(pos.azimuth),
      sunElevation: Math.round(pos.elevation * 10) / 10,
      icon: isDawn ? '🌅' : '🌇',
      label: isDawn ? '朝霞' : '晚霞',
      dateLabel: dayLabel(eventWallMs, nowWall),
      timeLabel: `${isDawn ? '日出' : '日落'} ${solar.formatWallTime(eventWallMs)}`,
      expectedTimeLabel: glowDuration > 0
        ? `${solar.formatWallTime(expectedStart)}–${solar.formatWallTime(expectedEnd)}`
        : '暂无明显霞光时段',
      probPct: res.probPct,
      probLevel: res.probLevel,
      intensity: res.intensity.toFixed(1),
      intensityLevel: res.intensityLevel,
      intensityLabel: res.intensityLabel,
      dots: [0, 1, 2, 3, 4].map(i => ({ i, on: i < res.intensityLevel })),
      rows: [
        { k: '总云量', v: fmtPct(cloudTotal) },
        { k: '高云', v: fmtPct(cloudHigh) },
        { k: '中云', v: fmtPct(cloudMid) },
        { k: '低云', v: fmtPct(cloudLow) },
        { k: '能见度', v: visKm.toFixed(1) + ' km' },
        { k: '相对湿度', v: Math.round(rhPct) + '%' },
        { k: '露点差', v: spreadC.toFixed(1) + ' ℃' },
        { k: '近 1h 降水', v: precipPrev.toFixed(1) + ' mm' },
        { k: '风向', v: Math.round(windDirDeg) + '°' },
        { k: '太阳方位', v: Math.round(pos.azimuth) + '°' }
      ],
      judge: [
        { k: '光路门控', v: g.all.toFixed(2) },
        { k: '画布评分', v: res.detail.soft.canvas.toFixed(2) },
        { k: '光学厚度 τ', v: m.tau.toFixed(2) },
        {
          k: '被照亮云量',
          v: `${Math.round(m.cloudLit * 100)}% (1−(1−高云)×(1−中云)×(1−低云)，仅计可照亮云层)`,
          wide: true
        }
      ]
    };
  },

  nearestIndex(times, target) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
});
