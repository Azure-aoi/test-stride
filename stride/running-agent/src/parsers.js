import { createHash } from "node:crypto";
import { parse as parseCsvText } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: false,
  trimValues: true
});

const COLUMN_ALIASES = {
  startedAt: ["started_at", "start_time", "date", "datetime", "时间", "开始时间"],
  distanceKm: ["distance_km", "distance", "距离", "公里"],
  durationSec: ["duration_sec", "duration", "time_sec", "时长", "秒"],
  avgPaceSecPerKm: ["avg_pace_sec_per_km", "pace_sec_per_km", "pace", "配速"],
  avgHeartRate: ["avg_heart_rate", "average_heart_rate", "heart_rate", "平均心率"],
  maxHeartRate: ["max_heart_rate", "maximum_heart_rate", "最大心率"],
  cadence: ["cadence", "步频"],
  elevationGainM: ["elevation_gain_m", "elevation", "爬升"],
  trainingLoad: ["training_load", "load", "训练负荷"],
  notes: ["notes", "note", "title", "备注", "标题"]
};

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      return object[key];
    }
  }
  return undefined;
}

function numeric(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T07:00:00+08:00`).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return new Date(`${text}+08:00`).toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function uploadExternalId(startedAt, distanceM, durationSec) {
  return `upload:${checksum(`${startedAt}|${distanceM}|${durationSec}`)}`;
}

function normalizeActivity(activity) {
  const durationSec = Math.max(1, Math.round(activity.durationSec));
  const distanceM = Math.max(0.1, Math.round(activity.distanceM));
  const avgPaceSecPerKm =
    activity.avgPaceSecPerKm ||
    (distanceM > 0 ? Math.round(durationSec / (distanceM / 1000)) : null);

  return {
    ...activity,
    startedAt: new Date(activity.startedAt).toISOString(),
    durationSec,
    distanceM,
    avgPaceSecPerKm,
    externalId:
      activity.externalId || uploadExternalId(activity.startedAt, distanceM, durationSec)
  };
}

export function parseCsv(buffer, filename = "runs.csv") {
  const records = parseCsvText(buffer.toString("utf8").replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true
  });

  const activities = [];
  const errors = [];
  for (const [index, row] of records.entries()) {
    const line = index + 2;
    const startedAt = parseDate(firstValue(row, COLUMN_ALIASES.startedAt));
    const distanceKm = numeric(firstValue(row, COLUMN_ALIASES.distanceKm));
    const durationSec = numeric(firstValue(row, COLUMN_ALIASES.durationSec));
    const avgPaceSecPerKm = numeric(firstValue(row, COLUMN_ALIASES.avgPaceSecPerKm));

    if (!startedAt) {
      errors.push({ line, message: "缺少有效的 started_at" });
      continue;
    }
    if (!distanceKm || distanceKm <= 0) {
      errors.push({ line, message: "distance_km 必须大于 0" });
      continue;
    }
    if ((!durationSec || durationSec <= 0) && (!avgPaceSecPerKm || avgPaceSecPerKm <= 0)) {
      errors.push({ line, message: "duration_sec 和 avg_pace_sec_per_km 至少填写一个" });
      continue;
    }

    const duration =
      durationSec && durationSec > 0
        ? durationSec
        : Math.round(distanceKm * avgPaceSecPerKm);

    try {
      activities.push(
        normalizeActivity({
          provider: "upload",
          startedAt,
          durationSec: duration,
          distanceM: distanceKm * 1000,
          avgPaceSecPerKm,
          avgHeartRate: numeric(firstValue(row, COLUMN_ALIASES.avgHeartRate)),
          maxHeartRate: numeric(firstValue(row, COLUMN_ALIASES.maxHeartRate)),
          cadence: numeric(firstValue(row, COLUMN_ALIASES.cadence)),
          elevationGainM: numeric(firstValue(row, COLUMN_ALIASES.elevationGainM)),
          trainingLoad: numeric(firstValue(row, COLUMN_ALIASES.trainingLoad)),
          raw: {
            filename,
            line,
            notes: firstValue(row, COLUMN_ALIASES.notes) || "导入跑步"
          }
        })
      );
    } catch {
      errors.push({ line, message: "该行无法转换为活动数据" });
    }
  }
  return { activities, errors };
}

function deepValues(node, targetKeys, results = []) {
  if (!node || typeof node !== "object") return results;
  for (const [key, value] of Object.entries(node)) {
    if (targetKeys.includes(key) && (typeof value === "string" || typeof value === "number")) {
      const parsed = numeric(value);
      if (parsed !== null) results.push(parsed);
    }
    if (value && typeof value === "object") deepValues(value, targetKeys, results);
  }
  return results;
}

function haversineMeters(a, b) {
  const earthRadius = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latDelta = toRadians(b.lat - a.lat);
  const lonDelta = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const value =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(value));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sampleRoute(points, maxPoints = 220) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0);
}

export function parseGpx(buffer, filename = "run.gpx") {
  const document = xmlParser.parse(buffer.toString("utf8"));
  const gpx = document.gpx || document;
  const segments = asArray(gpx.trk).flatMap((track) => asArray(track.trkseg));
  const trackpoints = segments.flatMap((segment) => asArray(segment.trkpt));

  if (!trackpoints.length) {
    return { activities: [], errors: [{ line: 1, message: "GPX 中没有找到 trkpt 轨迹点" }] };
  }

  const points = [];
  const times = [];
  const heartRates = [];
  const cadences = [];
  let elevationGainM = 0;
  let previousElevation = null;

  for (const point of trackpoints) {
    const lat = numeric(point["@_lat"]);
    const lon = numeric(point["@_lon"]);
    const time = point.time ? new Date(point.time) : null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon });
    }
    if (time && !Number.isNaN(time.getTime())) times.push(time);

    const hr = average(deepValues(point, ["hr", "heartrate", "HeartRateBpm"]));
    const cadence = average(deepValues(point, ["cad", "cadence"]));
    if (hr) heartRates.push(hr);
    if (cadence) cadences.push(cadence);

    const elevation = numeric(point.ele);
    if (Number.isFinite(elevation)) {
      if (previousElevation !== null && elevation > previousElevation) {
        elevationGainM += elevation - previousElevation;
      }
      previousElevation = elevation;
    }
  }

  if (!times.length || points.length < 2) {
    return {
      activities: [],
      errors: [{ line: 1, message: "GPX 缺少有效时间或轨迹点，无法计算跑步数据" }]
    };
  }

  let distanceM = 0;
  for (let index = 1; index < points.length; index += 1) {
    distanceM += haversineMeters(points[index - 1], points[index]);
  }
  const startedAt = times[0].toISOString();
  const durationSec = Math.max(1, Math.round((times.at(-1) - times[0]) / 1000));
  const avgHeartRate = average(heartRates);
  const cadence = average(cadences);

  return {
    activities: [
      normalizeActivity({
        provider: "upload",
        startedAt,
        durationSec,
        distanceM,
        avgHeartRate,
        maxHeartRate: heartRates.length ? Math.max(...heartRates) : null,
        cadence,
        elevationGainM,
        route: sampleRoute(points),
        raw: { filename, format: "gpx", pointCount: points.length }
      })
    ],
    errors: []
  };
}

function tcxTrackpoints(activity) {
  return asArray(activity.Lap).flatMap((lap) =>
    asArray(lap.Track).flatMap((track) => asArray(track.Trackpoint))
  );
}

export function parseTcx(buffer, filename = "run.tcx") {
  const document = xmlParser.parse(buffer.toString("utf8"));
  const activitiesNode = document.TrainingCenterDatabase?.Activities?.Activity;
  const records = asArray(activitiesNode);
  if (!records.length) {
    return { activities: [], errors: [{ line: 1, message: "TCX 中没有找到 Activity" }] };
  }

  const activities = [];
  for (const [activityIndex, activity] of records.entries()) {
    const laps = asArray(activity.Lap);
    if (!laps.length) continue;

    let durationSec = 0;
    let distanceM = 0;
    let weightedHeartRate = 0;
    let heartRateWeight = 0;
    let maxHeartRate = null;
    const cadenceValues = [];
    const route = [];

    for (const lap of laps) {
      const lapDuration = numeric(lap.TotalTimeSeconds) || 0;
      durationSec += lapDuration;
      distanceM += numeric(lap.DistanceMeters) || 0;
      const avgHr = numeric(lap.AverageHeartRateBpm?.Value ?? lap.AverageHeartRateBpm);
      const maxHr = numeric(lap.MaximumHeartRateBpm?.Value ?? lap.MaximumHeartRateBpm);
      const cadence = numeric(lap.Cadence);
      if (avgHr) {
        weightedHeartRate += avgHr * Math.max(lapDuration, 1);
        heartRateWeight += Math.max(lapDuration, 1);
      }
      if (maxHr) maxHeartRate = Math.max(maxHeartRate || 0, maxHr);
      if (cadence) cadenceValues.push(cadence);
    }

    for (const point of tcxTrackpoints(activity)) {
      const position = point.Position;
      const lat = numeric(position?.LatitudeDegrees);
      const lon = numeric(position?.LongitudeDegrees);
      if (Number.isFinite(lat) && Number.isFinite(lon)) route.push({ lat, lon });
    }

    const startedAt = parseDate(laps[0]?.["@_StartTime"]);
    if (!startedAt || durationSec <= 0 || distanceM <= 0) continue;

    activities.push(
      normalizeActivity({
        provider: "upload",
        startedAt,
        durationSec,
        distanceM,
        avgHeartRate: heartRateWeight ? weightedHeartRate / heartRateWeight : null,
        maxHeartRate,
        cadence: average(cadenceValues),
        elevationGainM: null,
        route: sampleRoute(route),
        raw: {
          filename,
          format: "tcx",
          activityIndex,
          sport: activity["@_Sport"] || activity.Sport || "Running"
        }
      })
    );
  }

  return {
    activities,
    errors: activities.length
      ? []
      : [{ line: 1, message: "TCX 中没有可用的时间、距离数据" }]
  };
}

export function parseImportFile(buffer, extension, filename) {
  const format = extension.replace(".", "").toLowerCase();
  if (format === "csv") return parseCsv(buffer, filename);
  if (format === "gpx") return parseGpx(buffer, filename);
  if (format === "tcx") return parseTcx(buffer, filename);
  throw new Error("仅支持 CSV、GPX 和 TCX 文件");
}
