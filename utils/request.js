// 网络请求封装：反查地名 + Open-Meteo 数据
// 说明：小程序需在「开发管理 → 服务器域名」把下面域名加入 request 合法域名：
//   https://api.open-meteo.com
//   https://air-quality-api.open-meteo.com
//   https://nominatim.openstreetmap.org
// 本地调试可在「详情 → 本地设置」勾选「不校验合法域名」。
//
// 选址不再依赖在线正向地理编码：自动定位用 wx.getLocation，
// 手动选址用 wx.chooseLocation（微信自带地图组件，自带搜索与拖动图钉，
// 且直接返回地名，无需域名白名单）。

// ECMWF / GFS / ICON 实际提供云量的气压层（顺序即绘图顺序，从近地面到高空）
const LEVELS_HPAS = {
  ec: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50],
  gfs: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50],
  icon: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30]
};

// 数据源 → Open-Meteo 模型名
const API_MODEL = {
  ec: 'ecmwf_ifs025',
  gfs: 'gfs_seamless',
  icon: 'icon_global'
};

// 渲染窗口：从当前整点开始共 72 小时（3 天）
// 用 forecast_hours 而不是 forecast_days，返回的时间序列第一项就是「站点当地时间的当前整点」
const FORECAST_HOURS = 72;

// 气溶胶光学厚度（AOD，无量纲），来自独立的空气质量接口（CAMS，不随所选气象模式变化）
const AEROSOL_VARS = 'aerosol_optical_depth';

function getJSON(url) {
  return new Promise(resolve => {
    wx.request({
      url,
      success: r => resolve(r && r.statusCode === 200 ? r.data : null),
      fail: err => {
        console.warn('[request] 请求失败（请检查 request 合法域名）', url, err);
        resolve(null);
      }
    });
  });
}

// 按时间轴把第二组逐小时序列对齐到第一组（返回与 targetTimes 等长的数组）
function alignHourly(targetTimes, srcTimes, srcValues) {
  if (!targetTimes || !srcTimes || !srcValues) return null;
  if (targetTimes.length === srcTimes.length) return srcValues;
  const map = {};
  for (let i = 0; i < srcTimes.length; i++) map[srcTimes[i]] = srcValues[i];
  return targetTimes.map(t => (Object.prototype.hasOwnProperty.call(map, t) ? map[t] : null));
}

// 经纬度反查地名（与网页版一致用 Nominatim）。失败返回空串，由调用方兜底展示坐标。
const reverseGeocode = async (lat, lon) => {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    '&format=jsonv2&zoom=10&accept-language=zh&_=' + Date.now();
  const j = await getJSON(url);
  if (j && j.address) {
    const a = j.address;
    return a.city || a.town || a.county || a.district || a.village || a.state || a.country || '';
  }
  return (j && j.name) || '';
};

// 云层剖面数据（气压层云量）+ 地面要素数据 + 气溶胶（AOD）
// forecast_hours=72 让服务端直接返回「从当地当前整点开始的 3 天」，
// 因此页面拿到的时间序列就是渲染窗口，不需要再做时区换算。
// model: 'ec' | 'gfs' | 'icon'，三个模式的可用气压层不同，需分别拼接。
// 地面要素（温湿度/降水/风）绑定所选模型；能见度只有 GFS 提供，
// 单独用 best_match 补，避免 ECMWF / ICON 下出现空值。
const fetchData = async (lat, lon, model = 'ec') => {
  const key = LEVELS_HPAS[model] ? model : 'ec';
  const lvVars = LEVELS_HPAS[key].map(h => `cloud_cover_${h}hPa`).join(',');
  const surf = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high';
  const surfVars = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m';
  const visVar = 'visibility';
  const apiModel = API_MODEL[key];
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`;
  const aqBase = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`;
  // 带上时间戳避免命中系统缓存，保证「当前整点」是真正当前的
  const stamp = Date.now();
  const url1 = `${base}&hourly=${surf},${lvVars}&models=${apiModel}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;
  const url2 = `${base}&hourly=${surfVars}&models=${apiModel}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;
  const url3 = `${aqBase}&hourly=${AEROSOL_VARS}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;
  const url4 = `${base}&hourly=${visVar}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;

  const [j1, j2, j3, j4] = await Promise.all([getJSON(url1), getJSON(url2), getJSON(url3), getJSON(url4)]);
  if (!j1 || !j1.hourly || !j1.hourly.time || !j1.hourly.time.length) {
    console.warn('[request] 云层数据无效', key, j1 && j1.reason);
    return null;
  }
  if (j2 && j2.hourly) j1.hourly_surface = j2.hourly;
  const surface = j1.hourly_surface || j1.hourly;
  // 能见度：单独用 best_match 取，对齐到云层时间轴（ECMWF / ICON 模型下仍有值）
  if (j4 && j4.hourly) {
    surface.visibility = alignHourly(j1.hourly.time, j4.hourly.time, j4.hourly.visibility);
  }
  if (j3 && j3.hourly) {
    surface.aerosol_optical_depth = alignHourly(j1.hourly.time, j3.hourly.time, j3.hourly.aerosol_optical_depth);
  }
  return j1;
};

// 光线路径云图：一次请求取多个采样点的逐小时云量。
// points: [{ latitude, longitude }]；dateStr: 'YYYY-MM-DD'（站点当地日期）
// 只取当天 24 小时，响应体积远小于完整预报；返回数组顺序与 points 一致。
const CLOUD_GRID_VARS = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high';

const fetchCloudGrid = async (points, dateStr, model = 'ec') => {
  if (!points || !points.length) return null;
  const key = LEVELS_HPAS[model] ? model : 'ec';
  const lats = points.map(p => p.latitude.toFixed(3)).join(',');
  const lons = points.map(p => p.longitude.toFixed(3)).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
    + `&hourly=${CLOUD_GRID_VARS}&models=${API_MODEL[key]}`
    + `&start_date=${dateStr}&end_date=${dateStr}&timezone=auto&_=${Date.now()}`;

  const j = await getJSON(url);
  if (!j) {
    console.warn('[request] 云图网格数据为空', key, dateStr);
    return null;
  }
  const list = Array.isArray(j) ? j : [j];
  if (list.length !== points.length) {
    console.warn('[request] 云图网格点数不匹配', list.length, points.length, j && j.reason);
    return null;
  }
  return list;
};

module.exports = {
  reverseGeocode,
  fetchData,
  fetchCloudGrid,
  LEVELS_HPAS,
  API_MODEL,
  FORECAST_HOURS
};
