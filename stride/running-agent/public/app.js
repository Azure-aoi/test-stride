const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const MODEL_KEY = "stride-os-model-config-v1";

const providerPresets = {
  local: {
    provider: "local",
    apiStyle: "chat-completions",
    baseUrl: "",
    model: "",
    label: "本地分析"
  },
  deepseek: {
    provider: "openai-compatible",
    apiStyle: "chat-completions",
    baseUrl: "https://api.deepseek.com/v1",
    model: "",
    label: "DeepSeek"
  },
  kimi: {
    provider: "openai-compatible",
    apiStyle: "chat-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "",
    label: "Kimi"
  },
  qwen: {
    provider: "openai-compatible",
    apiStyle: "chat-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "",
    label: "千问"
  },
  openai: {
    provider: "openai",
    apiStyle: "responses",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    label: "OpenAI"
  },
  anthropic: {
    provider: "anthropic",
    apiStyle: "messages",
    baseUrl: "https://api.anthropic.com",
    model: "",
    label: "Anthropic"
  },
  custom: {
    provider: "openai-compatible",
    apiStyle: "chat-completions",
    baseUrl: "",
    model: "",
    label: "自定义模型"
  }
};

const state = {
  route: "dashboard",
  range: 28,
  dashboard: null,
  activities: [],
  activityDetailId: null,
  activityDetail: null,
  imports: [],
  sources: [],
  coros: null,
  model: loadModelConfig(),
  chatBusy: false,
  selectedFile: null,
  sessions: [],
  currentSessionId: localStorage.getItem("stride-os-current-session") || null,
  sessionContext: null,
  currentRunId: null,
  runSessionId: null,
  runEventSource: null,
  seenRunEventIds: new Set(),
  queuedPlanPreview: null,
  chatPinnedBottom: true,
  debugMode: localStorage.getItem("stride-os-debug") === "1",
  calendarStart: null,
  calendarSessions: [],
  planPreviews: new Map(),
  pendingPlanPreview: null,
  actionResolver: null,
  activityFilters: {
    query: "",
    distance: "all",
    source: "all",
    sort: "latest"
  },
  compareActivityIds: []
};

function loadModelConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(MODEL_KEY) || "{}");
    if (!stored.provider) return { ...providerPresets.local };
    return {
      ...providerPresets.local,
      ...stored,
      apiKey: ""
    };
  } catch {
    return { ...providerPresets.local };
  }
}

function saveModelConfig(config) {
  const { apiKey, ...safeConfig } = config;
  localStorage.setItem(MODEL_KEY, JSON.stringify(safeConfig));
}

function providerKeyFromConfig() {
  if (state.model.provider === "local") return "local";
  if (state.model.provider === "anthropic") return "anthropic";
  if (state.model.provider === "openai") return "openai";
  const baseUrl = state.model.baseUrl || "";
  if (baseUrl.includes("deepseek")) return "deepseek";
  if (baseUrl.includes("moonshot")) return "kimi";
  if (baseUrl.includes("dashscope")) return "qwen";
  return "custom";
}

function activeModelLabel() {
  if (state.model.provider === "local") return "本地分析";
  const provider = providerKeyFromConfig();
  const label = providerPresets[provider]?.label || "自定义模型";
  const identity = state.model.model ? `${label} · ${state.model.model}` : label;
  return state.model.apiKey ? identity : `${identity} · 待填密钥`;
}

function modelReady() {
  return state.model.provider === "local" || Boolean(state.model.apiKey);
}

function requireModelReady() {
  if (modelReady()) return true;
  toast("模型密钥不会持久化，请重新填写 API Key", "error");
  applyModelToForm();
  openDialog("model-dialog");
  $("#api-key").focus();
  return false;
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(value) {
  const lines = String(value ?? "").replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let index = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(
      `<p>${paragraph.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`
    );
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(4, heading[1].length + 2);
      output.push(
        `<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`
      );
      index += 1;
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])
    ) {
      flushParagraph();
      const parseCells = (row) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const headers = parseCells(line);
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        lines[index].includes("|")
      ) {
        rows.push(parseCells(lines[index]));
        index += 1;
      }
      output.push(`
        <div class="chat-table-wrap">
          <table>
            <thead><tr>${headers
              .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
              .join("")}</tr></thead>
            <tbody>${rows
              .map(
                (row) =>
                  `<tr>${headers
                    .map(
                      (_, cellIndex) =>
                        `<td>${renderInlineMarkdown(row[cellIndex] || "")}</td>`
                    )
                    .join("")}</tr>`
              )
              .join("")}</tbody>
          </table>
        </div>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? "ul" : "ol";
      const matcher = unordered ? /^[-*+]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      const items = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(matcher);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quotes = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quotes.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      output.push(
        `<blockquote>${quotes
          .map((quote) => renderInlineMarkdown(quote))
          .join("<br>")}</blockquote>`
      );
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      output.push("<hr>");
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return output.join("");
}

function chatMessageMarkup(role, content, meta) {
  const isUser = role === "user";
  const body = isUser
    ? escapeHtml(content).replaceAll("\n", "<br>")
    : renderMarkdown(content);
  return `
    <div class="chat-bubble">${body}</div>
    <div class="chat-meta-row">
      <span class="chat-meta">${escapeHtml(
        meta || (isUser ? "你" : "教练")
      )}</span>
      ${
        isUser
          ? ""
          : `<button class="chat-copy" type="button" data-copy-message>复制</button>`
      }
    </div>`;
}

function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatDate(value, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(date);
}

function todayLabel() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
  return `${now.getMonth() + 1}月${now.getDate()}日 · ${weekday} · ${state.range} 天分析窗口`;
}

const ROUTE_META = {
  dashboard: {
    path: "/dashboard",
    kicker: "训练管理",
    title: "训练总览"
  },
  activities: {
    path: "/activities",
    kicker: "运动数据",
    title: "训练记录"
  },
  activity: {
    path: "/activities",
    kicker: "运动数据",
    title: "训练详情"
  },
  calendar: {
    path: "/calendar",
    kicker: "训练执行",
    title: "训练日历"
  },
  coach: {
    path: "/coach",
    kicker: "训练规划",
    title: "AI 教练"
  }
};

function activityIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/activities\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeKeyForPath(pathname) {
  if (activityIdFromPath(pathname)) return "activity";
  if (pathname === "/activities") return "activities";
  if (pathname === "/calendar") return "calendar";
  if (pathname === "/coach") return "coach";
  return "dashboard";
}

function setActiveRail(key = null) {
  const activePath = key === "activity" ? "/activities" : ROUTE_META[key]?.path;
  $$(".rail-button[data-route]").forEach((button) => {
    const active = Boolean(activePath && button.dataset.route === activePath);
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function scrollToRoute(pathname, { behavior = "smooth" } = {}) {
  if (!pathname || pathname === "/") {
    window.scrollTo({ top: 0, behavior });
    return;
  }
  const key = routeKeyForPath(pathname);
  const sectionId =
    key === "activity" ? "activity-detail-section" : `${key}-section`;
  const target = document.getElementById(sectionId);
  if (!target) return;
  const top = Math.max(
    0,
    window.scrollY + target.getBoundingClientRect().top - 78
  );
  if (behavior !== "smooth") {
    const root = document.documentElement;
    const previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, top);
    root.style.scrollBehavior = previousBehavior;
    return;
  }
  window.scrollTo({ top, behavior });
}

function renderRouteHeading() {
  const meta = ROUTE_META[state.route];
  if (!meta) return;
  $("#page-kicker").textContent = "训练管理";
  $("#page-title").textContent = "训练总览";
  $("#today-copy").textContent = state.dashboard
    ? todayLabel()
    : "正在读取本地训练数据...";
  document.title = `${meta.title} · STRIDE OS`;
}

function navigate(
  pathname,
  { push = true, replace = false, load = true, scroll = true } = {}
) {
  const key = routeKeyForPath(pathname);
  const meta = ROUTE_META[key];
  state.route = key;
  state.activityDetailId = key === "activity" ? activityIdFromPath(pathname) : null;
  if (key !== "activity") state.activityDetail = null;
  $$(".route-view").forEach((view) => {
    view.hidden = view.dataset.view === "activity" && key !== "activity";
  });
  setActiveRail(key);
  renderRouteHeading();
  if (load && key === "activity") {
    loadActivityDetail().catch((error) => toast(error.message, "error"));
  }
  if (load && key === "calendar") {
    loadCalendar().catch((error) => toast(error.message, "error"));
  }
  if (load && key === "coach" && state.currentSessionId) {
    loadCurrentSession().catch((error) => toast(error.message, "error"));
  }

  if (push || replace) {
    const method = replace ? "replaceState" : "pushState";
    const url = key === "activity" ? pathname : meta.path;
    window.history[method]({}, "", url);
  }
  if (scroll) {
    window.requestAnimationFrame(() => scrollToRoute(pathname));
  }
}

function syncActiveJourney() {
  const sections = $$("[data-journey-section]");
  const threshold = window.innerHeight * 0.42;
  let active = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    const rect = section.getBoundingClientRect();
    const distance = Math.abs(rect.top - threshold);
    if (rect.top <= threshold && distance < closestDistance) {
      active = section.dataset.view;
      closestDistance = distance;
    }
  }
  setActiveRail(active);
  const floatingAi = $("#go-coach");
  if (floatingAi) {
    floatingAi.classList.toggle(
      "is-hidden",
      !active || active === "coach" || active === "activity"
    );
  }
}

function initJourneyNavigation() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      syncActiveJourney();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule();
}

function initHeroParticles() {
  const canvas = $("#hero-particle-canvas");
  const hero = $(".landing-hero");
  if (!canvas || !hero) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  const pointer = { x: 0, y: 0, active: false };
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let frame = null;
  let inView = true;

  const buildParticles = () => {
    const count = Math.max(44, Math.min(96, Math.round(width / 15)));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      size: Math.random() * 1.5 + 0.7,
      phase: Math.random() * Math.PI * 2
    }));
  };

  const resize = () => {
    const rect = hero.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildParticles();
    cancelAnimationFrame(frame);
    draw(performance.now());
  };

  const draw = (time) => {
    context.clearRect(0, 0, width, height);
    const maxConnection = width < 760 ? 92 : 124;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      if (!reducedMotion && inView) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < -12) particle.x = width + 12;
        if (particle.x > width + 12) particle.x = -12;
        if (particle.y < -12) particle.y = height + 12;
        if (particle.y > height + 12) particle.y = -12;
        if (pointer.active) {
          const dx = particle.x - pointer.x;
          const dy = particle.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < 150) {
            const force = (1 - distance / 150) * 0.2;
            particle.x += (dx / distance) * force * 8;
            particle.y += (dy / distance) * force * 8;
          }
        }
      }

      const pulse = 0.55 + Math.sin(time * 0.0013 + particle.phase) * 0.2;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fillStyle = `rgba(201, 248, 76, ${pulse})`;
      context.fill();

      for (let next = index + 1; next < particles.length; next += 1) {
        const neighbor = particles[next];
        const dx = particle.x - neighbor.x;
        const dy = particle.y - neighbor.y;
        const distance = Math.hypot(dx, dy);
        if (distance > maxConnection) continue;
        const alpha = (1 - distance / maxConnection) * 0.14;
        context.beginPath();
        context.moveTo(particle.x, particle.y);
        context.lineTo(neighbor.x, neighbor.y);
        context.strokeStyle = `rgba(158, 202, 177, ${alpha})`;
        context.lineWidth = 0.7;
        context.stroke();
      }
    }

    if (pointer.active) {
      for (const particle of particles) {
        const distance = Math.hypot(particle.x - pointer.x, particle.y - pointer.y);
        if (distance > 170) continue;
        context.beginPath();
        context.moveTo(particle.x, particle.y);
        context.lineTo(pointer.x, pointer.y);
        context.strokeStyle = `rgba(201, 248, 76, ${(1 - distance / 170) * 0.24})`;
        context.lineWidth = 0.8;
        context.stroke();
      }
    }

    if (!reducedMotion && inView) frame = requestAnimationFrame(draw);
  };

  const handlePointerMove = (event) => {
    const rect = hero.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.active = true;
  };

  hero.addEventListener("pointermove", handlePointerMove);
  hero.addEventListener("pointerleave", () => {
    pointer.active = false;
  });
  new ResizeObserver(resize).observe(hero);
  new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      if (inView && !reducedMotion) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(draw);
      } else if (!inView) {
        cancelAnimationFrame(frame);
      }
    },
    { threshold: 0.01 }
  ).observe(hero);
  resize();
}

function sourceLabel(provider) {
  const labels = {
    demo: "示例",
    upload: "上传",
    coros: "高驰"
  };
  return labels[provider] || String(provider || "DATA").toUpperCase();
}

function activityTitle(activity) {
  const rawTitle = activity.raw?.title || activity.raw?.notes;
  if (rawTitle) {
    const firstLine = String(rawTitle)
      .replace(/\\n/g, "\n")
      .split(/\r?\n/)[0]
      .trim();
    if (firstLine && firstLine.length <= 80) return firstLine;
  }
  if (activity.provider === "coros") return "高驰跑步";
  return activity.provider === "upload" ? "导入跑步" : "跑步训练";
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " is-error" : ""}`;
  item.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== "string") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    const message =
      window.location.protocol === "file:"
        ? "页面是通过文件方式打开的。请先运行 npm run dev，再访问 http://localhost:4173。"
        : `无法连接本地服务（${window.location.origin}）。请确认 npm run dev 正在运行且端口一致，然后重试。`;
    const networkError = new Error(message);
    networkError.code = "NETWORK_UNREACHABLE";
    networkError.cause = error;
    throw networkError;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `请求失败 (${response.status})`);
    error.code = payload.error?.code;
    error.status = response.status;
    if (error.code === "AUTH_REQUIRED") openAuthDialog();
    throw error;
  }
  return payload;
}

function openAuthDialog() {
  openDialog("auth-dialog");
  window.setTimeout(() => $("#auth-password")?.focus(), 50);
}

async function checkAuthentication() {
  const status = await api("/api/auth/status");
  if (status.required && !status.authenticated) {
    openAuthDialog();
    return false;
  }
  return true;
}

async function submitAuthentication(event) {
  event.preventDefault();
  const result = $("#auth-result");
  result.hidden = true;
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: { password: $("#auth-password").value }
    });
    if (!payload.authenticated) throw new Error("登录失败");
    $("#auth-password").value = "";
    closeDialog("auth-dialog");
    await loadAll();
    toast("登录成功");
  } catch (error) {
    result.hidden = false;
    result.className = "test-result is-error";
    result.textContent = error.message;
  }
}

async function loadAll() {
  const [dashboardData, activityData, sessionData, sourceData, corosData] =
    await Promise.all([
      api(`/api/dashboard?days=${state.range}`),
      api("/api/activities?limit=200"),
      api("/api/sessions"),
      api("/api/sources"),
      api("/api/coros/status")
    ]);
  state.dashboard = dashboardData.dashboard;
  state.activities = activityData.activities;
  state.imports = dashboardData.imports;
  state.sources = sourceData.sources;
  state.coros = corosData;
  state.sessions = sessionData.sessions;
  const sessionExists = state.sessions.some(
    (session) => session.id === state.currentSessionId
  );
  if (!sessionExists) {
    state.currentSessionId = state.sessions[0]?.id || null;
  }
  localStorage.setItem(
    "stride-os-current-session",
    state.currentSessionId || ""
  );
  renderDashboard();
  renderActivities();
  await loadCurrentSession();
  renderSources();
  renderImports();
  renderCorosStatus();
  updateModelUI();
  renderSessions();
  await loadCalendar();
}

async function refreshDashboard() {
  const [data, activityData] = await Promise.all([
    api(`/api/dashboard?days=${state.range}`),
    api("/api/activities?limit=200")
  ]);
  state.dashboard = data.dashboard;
  state.activities = activityData.activities;
  state.imports = data.imports;
  renderDashboard();
  renderActivities();
  renderImports();
}

function updateMetricChange(element, value, options = {}) {
  const { inverse = false, suffix = "%" } = options;
  element.classList.remove("is-positive", "is-negative");
  if (value === null || value === undefined) {
    element.textContent = "暂无周期对比";
    return;
  }
  if (Math.abs(value) < 0.1) {
    element.textContent = "与上一周期持平";
    return;
  }
  const improved = inverse ? value < 0 : value > 0;
  element.classList.add(improved ? "is-positive" : "is-negative");
  const arrow = value > 0 ? "arrow-up" : "arrow-down";
  element.innerHTML = `${icon(arrow)} 较上期 ${Math.abs(value).toFixed(1)}${suffix}`;
}

function renderDashboard() {
  if (!state.dashboard) return;
  const { current, changes, readiness, latestRun, heartRateProfile } =
    state.dashboard;
  $("#metric-distance").textContent = current.distanceKm || "0";
  $("#metric-pace").textContent = formatPace(current.avgPaceSecPerKm);
  $("#metric-hr").textContent = current.avgHeartRate || "--";
  $("#metric-readiness").textContent = readiness.score || "--";
  $("#readiness-label").textContent = readiness.label;
  $("#readiness-score").textContent = readiness.score || "--";
  $("#readiness-copy").textContent = readiness.label;
  $("#readiness-note").textContent = readiness.note;
  $("#mini-runs").textContent = current.runCount || 0;
  $("#mini-longest").textContent = current.longestRunKm ? `${current.longestRunKm} km` : "--";
  $("#mini-load").textContent = current.trainingLoad || 0;
  $("#activity-count").textContent = `${state.activities.length} 条记录`;
  $("#coach-context-distance").textContent = `${current.distanceKm || 0} km`;
  $("#coach-context-pace").textContent = `${formatPace(current.avgPaceSecPerKm)} /km`;
  $("#coach-context-hr").textContent = `${current.avgHeartRate || "--"} bpm`;
  $("#coach-context-readiness").textContent = readiness.label;
  $("#coach-context-note").textContent = readiness.note;
  $("#coach-heart-profile").textContent =
    heartRateProfile?.sampleCount >= 3
      ? `个人心率档案 · ${heartRateProfile.sampleCount} 个训练日 · 中位数 ${heartRateProfile.medianBpm} bpm · 仅作训练过程建议`
      : "个人心率档案样本不足，心率不参与训练计划决策";
  $("#coach-heart-profile").title =
    heartRateProfile?.guidance || "心率仅用于训练过程建议";
  updateMetricChange($("#delta-distance"), changes.distancePct);
  updateMetricChange($("#delta-pace"), changes.pacePct, { inverse: true });
  updateMetricChange($("#delta-hr"), changes.heartRatePct, { inverse: true });
  updateGauge(readiness.score || 0);
  renderChart();

  const banner = $("#demo-banner");
  const hasDemo = state.activities.some((activity) => activity.provider === "demo");
  banner.hidden = !hasDemo;
  $("#history-banner").hidden = !(
    state.activities.length > 0 &&
    current.runCount === 0 &&
    !hasDemo
  );
  if (latestRun) {
    $("#chart-caption").textContent = `最近一次 · ${formatDate(latestRun.startedAt, true)} · ${(latestRun.distanceM / 1000).toFixed(1)} km`;
  }
  renderRouteHeading();
}

function updateGauge(score) {
  const progress = $("#gauge-progress");
  const clamped = Math.max(0, Math.min(100, score));
  const offset = 188 - (188 * clamped) / 100;
  progress.style.strokeDashoffset = String(offset);
}

function chartPath(points) {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function renderChart() {
  const trend = state.dashboard?.weekTrend || [];
  const values = trend.map((item) => Number(item.distanceKm) || 0);
  const width = 720;
  const height = 230;
  const left = 34;
  const right = 16;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(10, Math.ceil(Math.max(...values, 0) / 5) * 5);
  const points = values.map((value, index) => ({
    x: left + (plotWidth * index) / Math.max(1, values.length - 1),
    y: top + plotHeight - (value / maxValue) * plotHeight,
    value,
    label: trend[index]?.label || ""
  }));
  const path = chartPath(points);
  const areaPath = points.length
    ? `${path} L${points.at(-1).x} ${top + plotHeight} L${points[0].x} ${top + plotHeight} Z`
    : "";
  const gridLines = [0, 0.5, 1]
    .map((ratio) => {
      const y = top + plotHeight * ratio;
      const value = Math.round(maxValue * (1 - ratio));
      return `<line class="chart-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>
        <text class="chart-axis-label" x="${left - 8}" y="${y + 3}" text-anchor="end">${value}</text>`;
    })
    .join("");
  const labels = points
    .map(
      (point) =>
        `<text class="chart-axis-label" x="${point.x}" y="${height - 12}" text-anchor="middle">${escapeHtml(point.label)}</text>`
    )
    .join("");
  const circles = points
    .map(
      (point, index) =>
        `<circle class="chart-point${index === points.length - 1 ? " is-latest" : ""}" cx="${point.x}" cy="${point.y}" r="${index === points.length - 1 ? 4.2 : 2.8}" tabindex="0" data-chart-x="${escapeHtml(point.label)}" data-chart-y="${point.value}" aria-label="${escapeHtml(point.label)}，${point.value} 公里"><title>${point.label}: ${point.value} km</title></circle>`
    )
    .join("");

  $("#load-chart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="最近八周跑量趋势">
      ${gridLines}
      <path class="chart-area" d="${areaPath}"></path>
      <path class="chart-line" d="${path}"></path>
      ${circles}
      ${labels}
    </svg>
    <div class="chart-tooltip" id="chart-tooltip" hidden></div>
  `;
}

function getFilteredActivities() {
  const { query, distance, source, sort } = state.activityFilters;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = state.activities.filter((activity) => {
    const km = Number(activity.distanceM) / 1000;
    const searchable = [
      activityTitle(activity),
      formatDate(activity.startedAt, true),
      sourceLabel(activity.provider),
      activity.raw?.notes || ""
    ]
      .join(" ")
      .toLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
    if (distance === "short" && km >= 5) return false;
    if (distance === "middle" && (km < 5 || km > 10)) return false;
    if (distance === "long" && km <= 10) return false;
    if (source !== "all" && activity.provider !== source) return false;
    return true;
  });
  return filtered.sort((left, right) => {
    if (sort === "oldest") {
      return new Date(left.startedAt) - new Date(right.startedAt);
    }
    if (sort === "distance") {
      return Number(right.distanceM) - Number(left.distanceM);
    }
    if (sort === "pace") {
      return (
        (Number(left.avgPaceSecPerKm) || Number.POSITIVE_INFINITY) -
        (Number(right.avgPaceSecPerKm) || Number.POSITIVE_INFINITY)
      );
    }
    return new Date(right.startedAt) - new Date(left.startedAt);
  });
}

function renderActivitySourceOptions() {
  const select = $("#activity-source-filter");
  if (!select) return;
  const previous = state.activityFilters.source;
  const providers = [...new Set(state.activities.map((activity) => activity.provider))];
  select.innerHTML = `
    <option value="all">全部来源</option>
    ${providers
      .map(
        (provider) =>
          `<option value="${escapeHtml(provider)}">${escapeHtml(sourceLabel(provider))}</option>`
      )
      .join("")}`;
  select.value = providers.includes(previous) ? previous : "all";
  state.activityFilters.source = select.value;
}

function renderActivityCompareSummary() {
  const container = $("#activity-compare-summary");
  if (!container) return;
  const activities = state.compareActivityIds
    .map((id) => state.activities.find((activity) => activity.id === id))
    .filter(Boolean);
  state.compareActivityIds = activities.map((activity) => activity.id);
  renderActivityCompareGuide();
  if (activities.length !== 2) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const [left, right] = activities;
  const distanceDelta =
    (Number(left.distanceM) - Number(right.distanceM)) / 1000;
  const paceDelta =
    Number(left.avgPaceSecPerKm) - Number(right.avgPaceSecPerKm);
  const heartDelta =
    Number(left.avgHeartRate || 0) - Number(right.avgHeartRate || 0);
  const durationDelta =
    Number(left.durationSec || 0) - Number(right.durationSec || 0);
  const paceText =
    Math.abs(paceDelta) < 1
      ? "持平"
      : `${paceDelta < 0 ? "快" : "慢"} ${formatDuration(Math.abs(paceDelta))}`;
  container.innerHTML = `
    <div class="compare-summary-head">
      <div class="compare-summary-title">
        <p class="panel-kicker">两次训练对比</p>
        <div class="compare-run-pair">
          <div>
            <strong>${escapeHtml(activityTitle(left))}</strong>
            <span>${escapeHtml(formatDate(left.startedAt, true))} · ${formatDuration(left.durationSec)}</span>
          </div>
          <em>对比</em>
          <div>
            <strong>${escapeHtml(activityTitle(right))}</strong>
            <span>${escapeHtml(formatDate(right.startedAt, true))} · ${formatDuration(right.durationSec)}</span>
          </div>
        </div>
      </div>
      <button type="button" id="clear-activity-compare">清空对比</button>
    </div>
    <div class="compare-summary-grid">
      <div><small>距离差</small><b>${distanceDelta >= 0 ? "+" : ""}${distanceDelta.toFixed(1)} km</b></div>
      <div><small>配速差</small><b>${paceText}</b></div>
      <div><small>心率差</small><b>${heartDelta >= 0 ? "+" : ""}${heartDelta || 0} bpm</b></div>
      <div><small>时长差</small><b>${durationDelta >= 0 ? "+" : "-"}${formatDuration(Math.abs(durationDelta))}</b></div>
    </div>`;
  container.hidden = false;
}

function renderActivityCompareGuide() {
  const count = state.compareActivityIds.length;
  const copy = $("#activity-compare-guide-copy");
  const counter = $("#activity-compare-guide-count");
  const guide = $(".activity-compare-guide");
  if (!copy || !counter || !guide) return;
  counter.textContent = `${count} / 2`;
  guide.classList.toggle("is-complete", count === 2);
  copy.textContent =
    count === 0
      ? "勾选两条训练记录，查看距离、配速和心率差异。"
      : count === 1
        ? "已选择 1 条，再选择 1 条开始对比。"
        : "已选择 2 条，下方显示两次训练的差异。";
}

function renderActivityMobileList(activities) {
  const list = $("#activity-mobile-list");
  if (!list) return;
  if (!activities.length) {
    list.innerHTML = `<p class="activity-empty-state">当前筛选条件下没有训练记录。</p>`;
    return;
  }
  list.innerHTML = activities
    .map(
      (activity) => `
      <article class="activity-mobile-card" data-activity-id="${escapeHtml(activity.id)}" tabindex="0">
        <header>
          <div>
            <strong>${escapeHtml(activityTitle(activity))}</strong>
            <small>${formatDate(activity.startedAt, true)} · ${escapeHtml(sourceLabel(activity.provider))}</small>
          </div>
          <label class="activity-compare-choice">
            <input type="checkbox" data-compare-id="${escapeHtml(activity.id)}" ${state.compareActivityIds.includes(activity.id) ? "checked" : ""} />
            对比
          </label>
        </header>
        <dl>
          <div><dt>距离</dt><dd>${(activity.distanceM / 1000).toFixed(1)} km</dd></div>
          <div><dt>配速</dt><dd>${formatPace(activity.avgPaceSecPerKm)} /km</dd></div>
          <div><dt>心率</dt><dd>${activity.avgHeartRate || "--"} bpm</dd></div>
          <div><dt>负荷</dt><dd>${activity.trainingLoad || "--"}</dd></div>
        </dl>
        <div class="activity-mobile-actions">
          <button type="button" data-activity-action="rename" data-activity-id="${escapeHtml(activity.id)}">
            ${icon("edit")} 重命名
          </button>
          <button type="button" data-activity-action="delete" data-activity-id="${escapeHtml(activity.id)}">
            ${icon("trash")} 删除
          </button>
        </div>
      </article>`
    )
    .join("");
}

function renderActivities() {
  renderActivitySourceOptions();
  const activities = getFilteredActivities();
  const body = $("#activity-body");
  if (!state.activities.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="empty-activities">还没有跑步记录。上传文件后，训练数据会显示在这里。</div></td></tr>`;
    renderActivityMobileList([]);
    renderActivityScatter([]);
    renderActivityCompareSummary();
    return;
  }
  $("#activity-count").textContent =
    activities.length === state.activities.length
      ? `${state.activities.length} 条记录`
      : `${activities.length} / ${state.activities.length} 条记录`;
  if (!activities.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="empty-activities">当前筛选条件下没有训练记录。</div></td></tr>`;
    renderActivityMobileList([]);
    renderActivityScatter([]);
    renderActivityCompareSummary();
    return;
  }

  body.innerHTML = activities
    .map(
      (activity) => `
      <tr class="activity-row" data-activity-id="${escapeHtml(activity.id)}" data-distance="${Number(activity.distanceM) / 1000}" data-pace="${Number(activity.avgPaceSecPerKm) || 0}" data-heart="${Number(activity.avgHeartRate) || 0}" data-load="${Number(activity.trainingLoad) || 0}" data-title="${escapeHtml(activityTitle(activity))}" data-date="${escapeHtml(formatDate(activity.startedAt, true))}" data-source="${escapeHtml(sourceLabel(activity.provider))}" tabindex="0" role="link" aria-label="查看${escapeHtml(activityTitle(activity))}详情">
        <td class="compare-column">
          <input class="activity-compare-toggle" type="checkbox" data-compare-id="${escapeHtml(activity.id)}" ${state.compareActivityIds.includes(activity.id) ? "checked" : ""} aria-label="选择${escapeHtml(activityTitle(activity))}进行对比" />
        </td>
        <td>
          <div class="activity-name">
            <span class="activity-glyph">${icon("route")}</span>
            <span>
              <strong>${escapeHtml(activityTitle(activity))}</strong>
              <small>${formatDate(activity.startedAt, true)}</small>
            </span>
          </div>
        </td>
        <td><span class="activity-number">${(activity.distanceM / 1000).toFixed(1)}</span> km</td>
        <td><span class="activity-number">${formatPace(activity.avgPaceSecPerKm)}</span> /km</td>
        <td><span class="activity-number">${activity.avgHeartRate || "--"}</span> bpm</td>
        <td>${activity.trainingLoad || "--"}</td>
        <td><span class="source-badge">${sourceLabel(activity.provider)}</span></td>
        <td class="activity-actions-column">
          <div class="activity-row-actions">
            <button type="button" data-activity-action="rename" data-activity-id="${escapeHtml(activity.id)}" title="重命名训练" aria-label="重命名${escapeHtml(activityTitle(activity))}">
              ${icon("edit")}
            </button>
            <button type="button" data-activity-action="delete" data-activity-id="${escapeHtml(activity.id)}" title="删除训练" aria-label="删除${escapeHtml(activityTitle(activity))}">
              ${icon("trash")}
            </button>
          </div>
        </td>
      </tr>`
    )
    .join("");
  renderActivityMobileList(activities);
  renderActivityScatter(activities);
  renderActivityCompareSummary();
}

function tooltipPosition(tooltip, target, host) {
  if (!tooltip || !target || !host) return;
  tooltip.hidden = false;
  const targetRect = target.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const positionRect = tooltip.offsetParent?.getBoundingClientRect() || hostRect;
  const width = tooltip.offsetWidth || 280;
  const height = tooltip.offsetHeight || 150;
  const pointX = targetRect.left + targetRect.width / 2 - positionRect.left;
  const pointY = targetRect.top - positionRect.top;
  const edge = 10;
  const left = Math.min(
    Math.max(pointX, width / 2 + edge),
    positionRect.width - width / 2 - edge
  );
  tooltip.dataset.placement = pointY < height + 22 ? "below" : "above";
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${pointY}px`;
}

function showTrendTooltip(target) {
  const host = $("#load-chart");
  const tooltip = $("#chart-tooltip");
  if (!host || !tooltip || !target) return;
  tooltip.innerHTML = `
    <strong>${escapeHtml(target.dataset.chartY)} km</strong>
    <small>${escapeHtml(target.dataset.chartX || "训练周")}</small>`;
  tooltipPosition(tooltip, target, host);
}

function showActivityPointTooltip(target) {
  const tooltip = $("#activity-chart-tooltip");
  const host = $("#activity-scatter");
  if (!tooltip || !host) return;
  const activity = state.activities.find(
    (item) => item.id === target.dataset.activityId
  );
  if (!activity) return;
  tooltip.innerHTML = `
    <div class="activity-tooltip-head">
      <strong>${escapeHtml(activityTitle(activity))}</strong>
      <small>${escapeHtml(formatDate(activity.startedAt, true))} · ${escapeHtml(sourceLabel(activity.provider))}</small>
    </div>
    <div class="activity-tooltip-metrics">
      <div><small>距离 X</small><b>${(activity.distanceM / 1000).toFixed(1)} km</b></div>
      <div><small>配速 Y</small><b>${formatPace(activity.avgPaceSecPerKm)} /km</b></div>
      <div><small>平均心率</small><b>${activity.avgHeartRate || "--"} bpm</b></div>
    </div>`;
  tooltipPosition(tooltip, target, host);
}

function renderActivityScatter(sourceActivities = getFilteredActivities()) {
  const container = $("#activity-scatter");
  if (!container) return;
  const activities = sourceActivities.filter(
    (activity) =>
      Number(activity.distanceM) > 0 && Number(activity.avgPaceSecPerKm) > 0
  );
  if (!activities.length) {
    container.innerHTML = `<div class="empty-activities">当前筛选条件下没有可展示的距离与配速数据。</div>`;
    return;
  }

  const width = 760;
  const height = 250;
  const left = 46;
  const right = 22;
  const top = 22;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const distances = activities.map((activity) => activity.distanceM / 1000);
  const paces = activities.map((activity) => activity.avgPaceSecPerKm);
  const maxDistance = Math.max(5, Math.ceil(Math.max(...distances) / 2) * 2);
  const minPace = Math.max(0, Math.floor(Math.min(...paces) / 15) * 15);
  const maxPace = Math.ceil(Math.max(...paces) / 15) * 15;
  const paceSpan = Math.max(15, maxPace - minPace);
  const points = activities.map((activity) => ({
    activity,
    x: left + ((activity.distanceM / 1000) / maxDistance) * plotWidth,
    y: top + ((activity.avgPaceSecPerKm - minPace) / paceSpan) * plotHeight
  }));

  const yGrid = [0, 0.5, 1]
    .map((ratio) => {
      const y = top + plotHeight * ratio;
      const pace = minPace + paceSpan * ratio;
      return `<line class="scatter-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>
        <text class="scatter-axis" x="${left - 9}" y="${y + 3}" text-anchor="end">${formatPace(pace)}</text>`;
    })
    .join("");
  const xGrid = [0, 0.5, 1]
    .map((ratio) => {
      const x = left + plotWidth * ratio;
      return `<line class="scatter-grid" x1="${x}" y1="${top}" x2="${x}" y2="${top + plotHeight}"></line>
        <text class="scatter-axis" x="${x}" y="${height - 20}" text-anchor="middle">${(maxDistance * ratio).toFixed(0)} km</text>`;
    })
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="训练记录距离与配速散点图">
      ${yGrid}
      ${xGrid}
      <text class="scatter-axis-title" x="8" y="12">配速</text>
      <text class="scatter-axis-title" x="${width - 8}" y="${height - 2}" text-anchor="end">距离</text>
      ${points
        .map(
          ({ activity, x, y }) =>
            `<circle class="scatter-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" tabindex="0" data-activity-id="${escapeHtml(activity.id)}" aria-label="${escapeHtml(activityTitle(activity))}，${(activity.distanceM / 1000).toFixed(1)} 公里，配速 ${formatPace(activity.avgPaceSecPerKm)}"><title>${escapeHtml(activityTitle(activity))}</title></circle>`
        )
        .join("")}
    </svg>`;
}

function showActivityHoverCard(row, event) {
  const card = $("#activity-hover-card");
  if (!card || !row) return;
  const activityId = row.dataset.activityId;
  const contentChanged = card.dataset.activityId !== activityId;
  if (!contentChanged) {
    card.hidden = false;
    moveActivityHoverCard(event);
    return;
  }
  const distance = Number(row.dataset.distance) || 0;
  const heartRate = Number(row.dataset.heart) || 0;
  const load = Number(row.dataset.load) || 0;
  const pace = Number(row.dataset.pace) || 0;

  card.innerHTML = `
    <div class="activity-tooltip-head">
      <strong>${escapeHtml(row.dataset.title)}</strong>
      <small>${escapeHtml(row.dataset.date)} · ${escapeHtml(row.dataset.source)}</small>
    </div>
    <div class="hover-data-grid">
      <div><small>距离 X</small><b>${distance.toFixed(1)} km</b></div>
      <div><small>配速 Y</small><b>${formatPace(pace)} /km</b></div>
      <div><small>平均心率</small><b>${heartRate || "--"} bpm</b></div>
      <div><small>训练负荷</small><b>${load || "--"}</b></div>
    </div>`;
  card.dataset.activityId = activityId;
  card.hidden = false;
  moveActivityHoverCard(event);
}

function moveActivityHoverCard(event) {
  const card = $("#activity-hover-card");
  if (!card || card.hidden || !event) return;
  const margin = 16;
  const gap = 18;
  const width = card.offsetWidth || 310;
  const height = card.offsetHeight || 210;
  const left =
    event.clientX + gap + width > window.innerWidth - margin
      ? event.clientX - width - gap
      : event.clientX + gap;
  const top = Math.min(
    Math.max(margin, event.clientY + gap),
    window.innerHeight - height - margin
  );
  card.style.left = `${Math.max(margin, left)}px`;
  card.style.top = `${top}px`;
}

function highlightActivity(activityId) {
  $$("#activity-body .activity-row").forEach((row) => {
    row.classList.toggle("is-hovered", row.dataset.activityId === activityId);
  });
  $$("#activity-scatter .scatter-point").forEach((point) => {
    const isCurrent = point.dataset.activityId === activityId;
    point.classList.toggle("is-hovered", isCurrent);
    point.classList.toggle("is-dimmed", Boolean(activityId) && !isCurrent);
  });
}

function clearActivityHighlight() {
  highlightActivity(null);
  const card = $("#activity-hover-card");
  if (card) {
    card.hidden = true;
    delete card.dataset.activityId;
  }
}

function toggleActivityComparison(activityId, checked) {
  if (!activityId) return;
  if (!checked) {
    state.compareActivityIds = state.compareActivityIds.filter(
      (id) => id !== activityId
    );
    renderActivities();
    return;
  }
  if (state.compareActivityIds.includes(activityId)) return;
  if (state.compareActivityIds.length >= 2) {
    toast("一次只能对比两次训练，请先取消其中一项", "error");
    renderActivities();
    return;
  }
  state.compareActivityIds = [...state.compareActivityIds, activityId];
  renderActivities();
}

async function renameActivityRecord(activityId) {
  const activity = state.activities.find((item) => item.id === activityId);
  if (!activity) return;
  const title = await promptAction("修改这次训练在总览和记录列表中的显示名称。", {
    kicker: "训练记录",
    title: "重命名训练",
    label: "训练名称",
    value: activityTitle(activity),
    confirmLabel: "保存名称"
  });
  if (!title || title === activityTitle(activity)) return;
  if (title.length > 80) {
    toast("训练名称不能超过 80 个字符", "error");
    return;
  }
  try {
    await api(`/api/activities/${encodeURIComponent(activityId)}`, {
      method: "PATCH",
      body: { title }
    });
    await refreshDashboard();
    toast("训练名称已更新");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteActivityRecord(activityId) {
  const activity = state.activities.find((item) => item.id === activityId);
  if (!activity) return;
  const confirmed = await confirmAction(
    `将删除“${activityTitle(activity)}”这条训练记录。${
      activity.provider === "coros"
        ? "之后再次同步高驰时，这条记录可能重新出现。"
        : ""
    }`,
    {
      kicker: "训练记录",
      title: "删除这条训练？",
      confirmLabel: "删除记录",
      danger: true
    }
  );
  if (!confirmed) return;
  try {
    await api(`/api/activities/${encodeURIComponent(activityId)}`, {
      method: "DELETE"
    });
    state.compareActivityIds = state.compareActivityIds.filter(
      (id) => id !== activityId
    );
    if (state.activityDetailId === activityId) {
      state.activityDetail = null;
      navigate("/activities", { push: false });
    }
    await refreshDashboard();
    await loadCorosStatus().catch(() => {});
    toast("训练记录已删除");
  } catch (error) {
    toast(error.message, "error");
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function loadActivityDetail() {
  const container = $("#activity-detail-body");
  if (!container) return;
  const id = state.activityDetailId;
  if (!id) {
    container.innerHTML = `<div class="empty-activities">找不到这条训练记录。</div>`;
    return;
  }
  container.innerHTML = `<div class="skeleton detail-skeleton"></div>`;
  try {
    const payload = await api(`/api/activities/${encodeURIComponent(id)}`);
    state.activityDetail = payload.activity;
    renderActivityDetail();
    renderRouteHeading();
  } catch (error) {
    container.innerHTML = `<div class="empty-activities">${escapeHtml(error.message)}</div>`;
  }
}

function detailMetric(label, value, unit) {
  return `<article class="detail-metric">
    <span>${escapeHtml(label)}</span>
    <div><strong>${escapeHtml(value)}</strong>${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</div>
  </article>`;
}

function renderActivityDetail() {
  const activity = state.activityDetail;
  const container = $("#activity-detail-body");
  if (!container) return;
  if (!activity) {
    container.innerHTML = `<div class="empty-activities">找不到这条训练记录。</div>`;
    return;
  }
  const rows = [
    ["开始时间", formatDateTime(activity.startedAt)],
    ["总时长", formatDuration(activity.durationSec)],
    ["最大心率", activity.maxHeartRate ? `${Math.round(activity.maxHeartRate)} bpm` : "--"],
    ["平均步频", activity.cadence ? `${Math.round(activity.cadence)} spm` : "--"],
    [
      "累计爬升",
      Number.isFinite(activity.elevationGainM)
        ? `${Math.round(activity.elevationGainM)} m`
        : "--"
    ],
    [
      "训练负荷",
      Number.isFinite(activity.trainingLoad) ? String(Math.round(activity.trainingLoad)) : "--"
    ],
    ["数据来源", sourceLabel(activity.provider)],
    ["导入文件", activity.raw?.filename || "--"],
    ["备注", activity.raw?.notes || "--"]
  ];
  container.innerHTML = `
    <header class="detail-header">
      <div>
        <p class="panel-kicker">单次训练</p>
        <h2 id="activity-detail-title">${escapeHtml(activityTitle(activity))}</h2>
        <p class="detail-meta">${escapeHtml(formatDateTime(activity.startedAt))} · ${escapeHtml(sourceLabel(activity.provider))}</p>
      </div>
      <span class="source-badge">${escapeHtml(sourceLabel(activity.provider))}</span>
    </header>
    <div class="detail-metric-grid">
      ${detailMetric("距离", (activity.distanceM / 1000).toFixed(2), "km")}
      ${detailMetric("时长", formatDuration(activity.durationSec), "")}
      ${detailMetric("平均配速", formatPace(activity.avgPaceSecPerKm), "/km")}
      ${detailMetric("平均心率", activity.avgHeartRate || "--", "bpm")}
    </div>
    <div class="detail-grid">
      <section class="panel detail-panel">
        <header class="panel-header compact">
          <div>
            <p class="panel-kicker">轨迹</p>
            <h2>路线</h2>
          </div>
        </header>
        <div class="route-map" id="activity-route-map"></div>
      </section>
      <section class="panel detail-panel">
        <header class="panel-header compact">
          <div>
            <p class="panel-kicker">原始数据</p>
            <h2>详细指标</h2>
          </div>
        </header>
        <dl class="detail-list">
          ${rows
            .map(
              ([label, value]) =>
                `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
            )
            .join("")}
        </dl>
      </section>
    </div>`;
  renderRouteMap(activity.route);
}

function renderRouteMap(route) {
  const container = $("#activity-route-map");
  if (!container) return;
  const points = (Array.isArray(route) ? route : []).filter(
    (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
  );
  if (points.length < 2) {
    container.innerHTML = `<p class="empty-copy">这次训练没有可用的轨迹点。</p>`;
    return;
  }
  const width = 640;
  const height = 320;
  const padding = 24;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const lonScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const latSpan = maxLat - minLat || 1e-6;
  const lonSpan = (maxLon - minLon) * lonScale || 1e-6;
  const scale = Math.min(
    (width - padding * 2) / lonSpan,
    (height - padding * 2) / latSpan
  );
  const offsetX = (width - lonSpan * scale) / 2;
  const offsetY = (height - latSpan * scale) / 2;
  const coords = points.map((point) => ({
    x: offsetX + (point.lon - minLon) * lonScale * scale,
    y: offsetY + (maxLat - point.lat) * scale
  }));
  const line = coords
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    )
    .join(" ");
  const start = coords[0];
  const end = coords[coords.length - 1];
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="本次训练轨迹">
      <path class="route-line-shadow" d="${line}"></path>
      <path class="route-line" d="${line}"></path>
      <circle class="route-marker route-start" cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="5"></circle>
      <circle class="route-marker route-end" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="5"></circle>
    </svg>`;
}

function isoDate(date) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function startOfWeek(date = new Date()) {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  const day = result.getDay();
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
  return result;
}

function renderSessions() {
  const list = $("#session-list");
  if (!state.sessions.length) {
    list.innerHTML = `<p class="empty-copy">还没有会话。</p>`;
    return;
  }
  list.innerHTML = state.sessions
    .map(
      (session) => `
      <div class="session-row${session.id === state.currentSessionId ? " is-active" : ""}">
        <button class="session-select" type="button" data-session-id="${escapeHtml(session.id)}">
          <strong>${escapeHtml(session.title)}</strong>
          <small>${session.messageCount || 0} 条消息 · ${formatDate(session.updatedAt, true)}</small>
        </button>
        <div class="session-actions">
          <button type="button" data-session-rename="${escapeHtml(session.id)}" title="重命名">···</button>
          <button type="button" data-session-delete="${escapeHtml(session.id)}" title="删除会话">${icon("trash")}</button>
        </div>
      </div>`
    )
    .join("");
}

function renderSessionMemory() {
  const context = state.sessionContext;
  if (!context) {
    $("#session-memory-status").textContent = "当前会话暂无记忆统计";
    return;
  }
  const summary = context.summary ? " · 已生成摘要" : "";
  $("#session-memory-status").textContent =
    `${context.messageCount} 条消息 · 约 ${context.tokenCount || 0} tokens${summary}`;
}

async function loadCurrentSession() {
  if (!state.currentSessionId) return;
  const [messageData, contextData] = await Promise.all([
    api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/messages?limit=100`),
    api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/context`)
  ]);
  state.sessionContext = contextData.context;
  renderChatMessages(messageData.messages);
  renderSessions();
  renderSessionMemory();
}

async function refreshSessionMeta() {
  const [sessions, contextData] = await Promise.all([
    api("/api/sessions"),
    api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/context`)
  ]);
  state.sessions = sessions.sessions;
  state.sessionContext = contextData.context;
  renderSessions();
  renderSessionMemory();
}

async function selectSession(sessionId) {
  if (state.chatBusy) {
    toast("当前回答正在运行，请先等待完成或停止运行", "error");
    return;
  }
  hideRunTrace({ clear: true });
  state.currentSessionId = sessionId;
  localStorage.setItem("stride-os-current-session", sessionId);
  renderSessions();
  await loadCurrentSession();
}

async function createNewSession() {
  if (state.chatBusy) {
    toast("当前回答正在运行，请先等待完成或停止运行", "error");
    return null;
  }
  hideRunTrace({ clear: true });
  const data = await api("/api/sessions", {
    method: "POST",
    body: { title: `训练对话 ${state.sessions.length + 1}` }
  });
  state.sessions.unshift({
    ...data.session,
    messageCount: 0,
    tokenCount: 0
  });
  state.currentSessionId = data.session.id;
  localStorage.setItem("stride-os-current-session", data.session.id);
  renderSessions();
  await loadCurrentSession();
}

async function renameSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const title = await promptAction("给这段训练对话一个更容易辨认的名称。", {
    kicker: "对话历史",
    title: "重命名会话",
    label: "会话名称",
    value: session.title,
    confirmLabel: "保存名称"
  });
  if (!title) return;
  const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: { title }
  });
  Object.assign(session, data.session);
  renderSessions();
}

async function removeSession(sessionId) {
  if (state.chatBusy) {
    toast("当前回答正在运行，请先等待完成或停止运行", "error");
    return;
  }
  if (
    !(await confirmAction("会话及其中的对话记录会从本机删除，此操作无法撤销。", {
      kicker: "对话历史",
      title: "删除这个会话？",
      confirmLabel: "删除会话",
      danger: true
    }))
  ) {
    return;
  }
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  });
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  if (state.currentSessionId === sessionId) {
    state.currentSessionId = state.sessions[0]?.id || null;
    localStorage.setItem("stride-os-current-session", state.currentSessionId || "");
  }
  renderSessions();
  await loadCurrentSession();
}

async function loadCalendar(startDate = null) {
  const start = startDate
    ? startOfWeek(new Date(`${startDate}T12:00:00`))
    : startOfWeek(new Date());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  state.calendarStart = isoDate(start);
  const data = await api(
    `/api/training/calendar?start=${isoDate(start)}&end=${isoDate(end)}`
  );
  state.calendarSessions = data.sessions;
  renderCalendar(start, end);
}

function renderCalendar(start, end) {
  const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const todayKey = isoDate(new Date());
  const byDate = new Map(
    state.calendarSessions.map((session) => [session.date, session])
  );
  $("#calendar-range").textContent =
    `${formatDate(start)} 至 ${formatDate(end)} · ${state.calendarSessions.length} 节课程`;
  $("#calendar-grid").innerHTML = weekdays
    .map((label, index) => {
      const date = new Date(start);
      date.setDate(date.getDate() + index);
      const dateKey = isoDate(date);
      const session = byDate.get(dateKey);
      const workout = session?.workout || null;
      const isToday = dateKey === todayKey;
      return `
        <article class="calendar-day${session ? " has-session" : ""}${isToday ? " is-today" : ""}" data-calendar-date="${dateKey}">
          <header>
            <span>${label}</span>
            <strong>${date.getMonth() + 1}/${date.getDate()}</strong>
          </header>
          ${
            session
              ? `<div class="calendar-workout">
                  <span class="calendar-status is-${escapeHtml(session.status)}">${escapeHtml(
                    session.status === "completed"
                      ? "已完成"
                      : session.status === "skipped"
                        ? "已跳过"
                        : "待执行"
                  )}</span>
                  <h3>${escapeHtml(workout.title || "训练")}</h3>
                  <p>${escapeHtml(workout.volume || "")}</p>
                  <small>${escapeHtml(workout.effort || workout.purpose || "")}</small>
                  <div class="calendar-checkin">
                    <input type="number" min="1" max="10" value="${session.rpe || ""}" placeholder="RPE" aria-label="RPE" data-calendar-rpe="${session.id}" />
                    <button type="button" data-calendar-complete="${session.id}">完成</button>
                    <button type="button" data-calendar-skip="${session.id}">跳过</button>
                  </div>
                </div>`
              : `<div class="calendar-empty">
                  <span>恢复日</span>
                  <p>暂无课程安排</p>
                </div>`
          }
        </article>`;
    })
    .join("");
}

function renderSources() {
  const uploadSources = state.sources.filter((source) => source.id !== "upload");
  $("#source-list").innerHTML = uploadSources
    .map(
      (source) => {
        const content = `
        <span class="source-symbol letter">${escapeHtml(source.name.slice(0, 1).toUpperCase())}</span>
        <span>
          <strong>${escapeHtml(source.name)}</strong>
          <small>${escapeHtml(source.detail)}</small>
        </span>
        <span class="source-status${source.status === "connected" ? " is-connected" : ""}">${
          source.status === "connected"
            ? "已连接"
            : source.status === "available"
              ? "可用"
              : source.status === "configuration_required"
                ? "需配置"
                : "待接入"
        }</span>`;
        if (source.id === "coros") {
          return `<button class="source-item source-item-button" type="button" data-open-coros>${content}</button>`;
        }
        return `<div class="source-item">${content}</div>`;
      }
    )
    .join("");
}

function renderCorosStatus() {
  const status = state.coros || { connected: false };
  const connected = Boolean(status.connected);
  $("#coros-title").textContent = connected ? "高驰已连接" : "尚未连接";
  $("#coros-detail").textContent = connected
    ? `${status.issuer || "高驰 MCP"} · ${status.activityCount || 0} 条高驰活动`
    : "使用 OAuth 2.0 授权读取你的高驰训练数据。";
  $("#coros-state-dot").classList.toggle("is-connected", connected);
  $("#coros-disconnected").hidden = connected;
  $("#coros-connected").hidden = !connected;
  $("#upload-coros-state").textContent = connected ? "已连接" : "可接入";
  $("#upload-coros-state").classList.toggle("is-connected", connected);
  $("#upload-coros-detail").textContent = connected
    ? `已同步 ${status.activityCount || 0} 条高驰活动，可继续更新记录`
    : "OAuth 授权后自动读取高驰训练记录";
  $("#upload-coros-action").textContent = connected ? "同步记录" : "连接 MCP";
  $("#upload-open-coros").classList.toggle("is-connected", connected);
  if (!connected) return;

  const region = status.regions?.find((item) => item.id === status.region);
  $("#coros-region-label").textContent = region?.label || status.region || "--";
  $("#coros-expires").textContent = status.expiresAt ? formatDate(status.expiresAt) : "--";
  $("#coros-activity-count").textContent = String(status.activityCount || 0);
}

async function loadCorosStatus() {
  state.coros = await api("/api/coros/status");
  const source = state.sources.find((item) => item.id === "coros");
  if (source) {
    source.status = state.coros.connected ? "connected" : "authorization_required";
    source.detail = state.coros.connected
      ? `已连接 · ${state.coros.activityCount || 0} 条活动`
      : "通过 OAuth 连接";
  }
  renderCorosStatus();
  renderSources();
  return state.coros;
}

async function openCorosDialog() {
  openDialog("coros-dialog");
  try {
    await loadCorosStatus();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function connectCoros() {
  const region = $("#coros-region").value || "global";
  window.location.href = `/api/auth/coros/start?region=${encodeURIComponent(region)}`;
}

async function syncCoros() {
  const button = $("#coros-sync");
  const resultBox = $("#coros-sync-result");
  const days = Number($("#coros-sync-days").value || 30);
  button.disabled = true;
  button.innerHTML = `${icon("refresh")}正在同步...`;
  resultBox.hidden = true;
  try {
    const result = await api("/api/coros/sync", {
      method: "POST",
      body: { days }
    });
    resultBox.hidden = false;
    resultBox.className = "import-result";
    if (result.imported > 0 || result.updated > 0) {
      const changes = [];
      if (result.imported > 0) changes.push(`新增 ${result.imported} 条`);
      if (result.updated > 0) changes.push(`更新 ${result.updated} 条`);
      resultBox.textContent = `同步完成：${changes.join("，")}。`;
    } else {
      resultBox.textContent = result.message || "高驰数据已是最新。";
    }
    await Promise.all([refreshDashboard(), loadCorosStatus()]);
    renderSources();
    toast(
      result.imported > 0 || result.updated > 0
        ? `高驰数据已更新：新增 ${result.imported} 条，更新 ${result.updated} 条`
        : "高驰数据已是最新"
    );
  } catch (error) {
    resultBox.hidden = false;
    resultBox.className = "import-result is-error";
    resultBox.textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("refresh")}同步训练记录`;
  }
}

async function inspectCoros() {
  const button = $("#coros-inspect");
  const summary = $("#coros-tool-summary");
  button.disabled = true;
  button.innerHTML = `${icon("database")}检查中...`;
  try {
    const result = await api("/api/coros/tools");
    const names = result.tools.slice(0, 8).map((tool) => tool.name);
    summary.hidden = false;
    summary.textContent = `高驰 MCP 可用工具 ${result.count} 个：${names.join("、")}${
      result.count > names.length ? " 等" : ""
    }。活动同步使用 querySportRecords。`;
  } catch (error) {
    summary.hidden = false;
    summary.textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("database")}检查 MCP`;
  }
}

async function disconnectCorosAccount() {
  if (
    !(await confirmAction(
      "断开后会清除本机保存的高驰 OAuth 令牌，已同步到工作台的跑步记录会保留。",
      {
        kicker: "高驰连接",
        title: "断开高驰账号？",
        confirmLabel: "断开连接",
        danger: true
      }
    ))
  ) {
    return;
  }
  try {
    await api("/api/coros/connection", { method: "DELETE" });
    $("#coros-tool-summary").hidden = true;
    $("#coros-sync-result").hidden = true;
    await Promise.all([loadCorosStatus(), loadAll()]);
    toast("高驰连接已断开");
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderChatMessages(messages = []) {
  const stream = $("#chat-stream");
  if (!messages.length) {
    stream.innerHTML = `
      <div class="chat-empty" id="chat-empty">
        ${icon("message")}
        <h3>从训练数据开始</h3>
        <p>询问近期配速、负荷变化或下一次训练安排。</p>
      </div>`;
    return;
  }
  stream.innerHTML = messages
    .map(
      (message) => `
      <article class="chat-message is-${message.role === "user" ? "user" : "assistant"}">
        ${chatMessageMarkup(
          message.role,
          message.content,
          message.role === "user" ? "你" : message.modelLabel || "教练"
        )}
      </article>`
    )
    .join("");
  scrollChatToBottom(true);
}

function isChatNearBottom(threshold = 70) {
  const stream = $("#chat-stream");
  return (
    stream.scrollHeight - stream.scrollTop - stream.clientHeight <= threshold
  );
}

function scrollChatToBottom(force = false, wasNearBottom = null) {
  const shouldFollow =
    force || (wasNearBottom === null ? state.chatPinnedBottom : wasNearBottom);
  if (!shouldFollow) return;
  const stream = $("#chat-stream");
  stream.scrollTop = stream.scrollHeight;
  state.chatPinnedBottom = true;
}

function appendChatMessage(role, content, meta = "", options = {}) {
  const stream = $("#chat-stream");
  const wasNearBottom =
    options.wasNearBottom ??
    state.chatPinnedBottom ??
    isChatNearBottom();
  $("#chat-empty")?.remove();
  const article = document.createElement("article");
  article.className = `chat-message is-${role}`;
  article.innerHTML = chatMessageMarkup(role, content, meta);
  stream.append(article);
  scrollChatToBottom(false, wasNearBottom);
  return article;
}

function appendTyping() {
  const stream = $("#chat-stream");
  const wasNearBottom = state.chatPinnedBottom || isChatNearBottom();
  $("#chat-empty")?.remove();
  const article = document.createElement("article");
  article.className = "chat-message is-assistant";
  article.id = "typing-message";
  article.innerHTML = `
    <div class="chat-bubble typing-indicator"><span></span><span></span><span></span></div>
    <span class="chat-meta">${escapeHtml(activeModelLabel())}</span>`;
  stream.append(article);
  scrollChatToBottom(false, wasNearBottom);
}

async function copyChatMessage(button) {
  const message = button.closest(".chat-message");
  const content = message?.querySelector(".chat-bubble")?.innerText || "";
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  button.textContent = "已复制";
  window.setTimeout(() => {
    button.textContent = "复制";
  }, 1600);
}

function readModelForm() {
  const selectedKey = $("#provider-select").value;
  const preset = providerPresets[selectedKey] || providerPresets.custom;
  const model = $("#model-name").value.trim();
  return {
    provider: preset.provider,
    apiStyle: $("#api-style").value,
    baseUrl: $("#base-url").value.trim(),
    model,
    fallbackModel: $("#fallback-model").value.trim(),
    planningModel: $("#planning-model").value.trim(),
    apiKey: $("#api-key").value.trim(),
    label: model ? `${preset.label} · ${model}` : preset.label
  };
}

function updateModelUI() {
  const label = activeModelLabel();
  $("#active-model-label").textContent = label;
  $("#coach-model-label").textContent = label;
  $("#coach-model-label").title = label;
  $("#coach-model-action").textContent =
    state.model.provider === "local"
      ? "接入我的模型"
      : state.model.apiKey
        ? "更换模型"
        : "填写模型密钥";
}

function applyModelToForm() {
  const key = providerKeyFromConfig();
  $("#provider-select").value = key;
  $("#model-name").value = state.model.model || "";
  $("#fallback-model").value = state.model.fallbackModel || "";
  $("#planning-model").value = state.model.planningModel || "";
  $("#api-style").value = state.model.apiStyle || "chat-completions";
  $("#base-url").value = state.model.baseUrl || "";
  $("#api-key").value = "";
  toggleLocalFields();
}

function toggleLocalFields() {
  const isLocal = $("#provider-select").value === "local";
  $("#model-name").disabled = isLocal;
  $("#api-style").disabled = isLocal;
  $("#base-url").disabled = isLocal;
  $("#api-key").disabled = isLocal;
  $("#fallback-model").disabled = isLocal;
  $("#planning-model").disabled = isLocal;
  $("#test-model").disabled = false;
  if (isLocal) {
    $("#model-name").value = "";
    $("#base-url").value = "";
    $("#api-key").value = "";
    $("#fallback-model").value = "";
    $("#planning-model").value = "";
  }
}

function openModelSettings() {
  applyModelToForm();
  openDialog("model-dialog");
}

function fillProviderPreset() {
  const key = $("#provider-select").value;
  const preset = providerPresets[key] || providerPresets.custom;
  if (key === "local") {
    toggleLocalFields();
    return;
  }
  if (!$("#base-url").value || Object.values(providerPresets).some((item) => item.baseUrl === $("#base-url").value)) {
    $("#base-url").value = preset.baseUrl;
  }
  $("#api-style").value = preset.apiStyle;
  $("#model-name").value = preset.model || "";
  $("#model-name").placeholder = key === "openai" ? "输入当前可用的 OpenAI 模型 ID" : "输入模型 ID";
  toggleLocalFields();
}

const memoryTypeLabels = {
  profile: "个人资料",
  goal: "训练目标",
  preference: "训练偏好",
  injury: "伤病限制",
  decision: "历史决策"
};

function fillProfileForm(profile) {
  $("#profile-name").value = profile.displayName || "";
  $("#profile-goal-race").value = profile.goalRace || "";
  $("#profile-goal-date").value = profile.goalDate || "";
  $("#profile-target-time").value = profile.targetTime || "";
  $("#profile-pb5k").value = profile.pb5k || "";
  $("#profile-pb10k").value = profile.pb10k || "";
  $("#profile-pb-half").value = profile.pbHalf || "";
  $("#profile-pb-full").value = profile.pbFull || "";
  $("#profile-days").value = profile.availableDays || "";
  $("#profile-injuries").value = profile.injuryNotes || "";
  $("#profile-notes").value = profile.notes || "";
  $("#profile-updated").textContent = profile.updatedAt
    ? `更新于 ${formatDate(profile.updatedAt, true)}`
    : "尚未保存";
}

function renderMemoryList(memories = []) {
  $("#memory-count").textContent = `${memories.length} 条`;
  const list = $("#memory-list");
  if (!memories.length) {
    list.innerHTML = `<p class="empty-copy">还没有长期记忆。可以记录训练偏好、目标或限制。</p>`;
    return;
  }
  list.innerHTML = memories
    .map(
      (memory) => `
      <article class="memory-row">
        <div>
          <span class="memory-type">${escapeHtml(memoryTypeLabels[memory.type] || memory.type)}</span>
          <p>${escapeHtml(memory.content)}</p>
          <small>重要性 ${Number(memory.importance).toFixed(1)} · ${escapeHtml(memory.source || "manual")}</small>
        </div>
        <div class="memory-actions">
          <button type="button" data-memory-edit="${escapeHtml(memory.id)}">编辑</button>
          <button type="button" data-memory-delete="${escapeHtml(memory.id)}">删除</button>
        </div>
      </article>`
    )
    .join("");
}

async function openMemoryDialog() {
  openDialog("memory-dialog");
  try {
    const [profileData, memoryData] = await Promise.all([
      api("/api/profile"),
      api("/api/memory")
    ]);
    fillProfileForm(profileData.profile);
    renderMemoryList(memoryData.memories);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveProfile() {
  const profile = {
    displayName: $("#profile-name").value,
    goalRace: $("#profile-goal-race").value,
    goalDate: $("#profile-goal-date").value,
    targetTime: $("#profile-target-time").value,
    pb5k: $("#profile-pb5k").value,
    pb10k: $("#profile-pb10k").value,
    pbHalf: $("#profile-pb-half").value,
    pbFull: $("#profile-pb-full").value,
    availableDays: $("#profile-days").value,
    injuryNotes: $("#profile-injuries").value,
    notes: $("#profile-notes").value
  };
  const data = await api("/api/profile", { method: "PUT", body: profile });
  fillProfileForm(data.profile);
  toast("跑者档案已保存");
}

async function addMemory() {
  const content = $("#memory-content").value.trim();
  if (!content) {
    toast("请先填写记忆内容", "error");
    return;
  }
  await api("/api/memory", {
    method: "POST",
    body: {
      type: $("#memory-type").value,
      content,
      importance: Number($("#memory-importance").value || 0.6)
    }
  });
  $("#memory-content").value = "";
  const data = await api("/api/memory");
  renderMemoryList(data.memories);
  toast("长期记忆已添加");
}

async function editMemory(id) {
  const memoryData = await api("/api/memory");
  const memory = memoryData.memories.find((item) => item.id === id);
  if (!memory) return;
  const content = await promptAction("修改这条长期记忆的内容，类型与重要度保持不变。", {
    kicker: "长期记忆",
    title: "编辑记忆",
    label: "记忆内容",
    value: memory.content,
    confirmLabel: "保存记忆"
  });
  if (!content) return;
  await api(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: {
      content,
      importance: memory.importance,
      type: memory.type
    }
  });
  renderMemoryList((await api("/api/memory")).memories);
  toast("记忆已更新");
}

async function removeMemory(id) {
  if (
    !(await confirmAction("这条记忆会从跑者档案中长期移除。", {
      kicker: "长期记忆",
      title: "删除这条记忆？",
      confirmLabel: "删除记忆",
      danger: true
    }))
  ) {
    return;
  }
  await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  renderMemoryList((await api("/api/memory")).memories);
  toast("记忆已删除");
}

function updateDebugVisibility() {
  $("#debug-mode").checked = state.debugMode;
  $("#open-context-debug").hidden = !state.debugMode || !state.currentRunId;
}

async function openContextDebug() {
  if (!state.debugMode) {
    toast("请先在 AI 教练页开启开发者模式", "error");
    return;
  }
  if (!state.currentRunId) {
    toast("当前没有可查看的运行记录", "error");
    return;
  }
  try {
    const data = await api(
      `/api/agent/runs/${encodeURIComponent(state.currentRunId)}/context`
    );
    $("#context-debug-content").textContent = JSON.stringify(data, null, 2);
    openDialog("context-debug-dialog");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function testModelFromForm() {
  const button = $("#test-model");
  const result = $("#model-test-result");
  button.disabled = true;
  result.hidden = true;
  try {
    const payload = await api("/api/model/test", { method: "POST", body: readModelForm() });
    result.hidden = false;
    result.className = "test-result is-success";
    result.textContent = payload.message || "连接成功";
  } catch (error) {
    result.hidden = false;
    result.className = "test-result is-error";
    result.textContent = `${error.message}${error.code ? `（${error.code}）` : ""}`;
  } finally {
    button.disabled = false;
  }
}

const stageLabels = {
  queued: "等待运行",
  planning: "分析任务",
  acting: "调用工具",
  observing: "读取结果",
  reflecting: "检查回答",
  completed: "运行完成",
  failed: "运行失败",
  cancelled: "已停止",
  reconnecting: "连接中断，正在恢复"
};

const toolLabels = {
  getRecentActivities: "查询近期活动",
  getTrainingMetrics: "计算训练指标",
  getRunnerProfile: "读取跑者档案",
  searchMemories: "检索长期记忆",
  generateTrainingPlan: "生成训练计划",
  syncActivitySource: "同步运动数据",
  previewPlanWrite: "预览计划写入",
  publishPlan: "写入训练计划"
};

function resetRunTrace(runId) {
  state.currentRunId = runId;
  state.runSessionId = state.currentSessionId;
  state.seenRunEventIds = new Set();
  state.queuedPlanPreview = null;
  $("#agent-trace").hidden = false;
  $("#agent-stage").textContent = "等待运行";
  $("#agent-run-meta").textContent = "";
  $("#agent-trace-steps").innerHTML = "";
  $("#cancel-run").hidden = false;
  $("#retry-run").hidden = true;
  updateDebugVisibility();
}

function hideRunTrace({ clear = false } = {}) {
  const trace = $("#agent-trace");
  if (!trace) return;
  trace.hidden = true;
  $("#open-context-debug").hidden = true;
  $("#retry-run").hidden = true;
  $("#cancel-run").hidden = true;
  if (clear) {
    $("#agent-trace-steps").innerHTML = "";
    state.queuedPlanPreview = null;
  }
  updateDebugVisibility();
}

function setRunStage(stageName) {
  $("#agent-stage").textContent = stageLabels[stageName] || stageName;
}

function traceStepElement(stepNo, toolName) {
  return $(`#trace-step-${stepNo}-${String(toolName).replaceAll(/[^a-zA-Z0-9_-]/g, "")}`);
}

function summarizeToolOutput(output) {
  if (!output) return "";
  if (output.message) return output.message;
  if (output.plan) {
    return `${output.plan.title}：${output.plan.reason}`;
  }
  if (output.current) {
    return `跑量 ${output.current.distanceKm || 0} km，配速 ${formatPace(
      output.current.avgPaceSecPerKm
    )}/km，状态 ${output.readiness?.label || "--"}`;
  }
  if (Array.isArray(output.activities)) return `${output.activities.length} 条活动`;
  if (Array.isArray(output.memories)) return `${output.memories.length} 条相关记忆`;
  if (output.imported !== undefined) {
    return `新增 ${output.imported || 0} 条，更新 ${output.updated || 0} 条`;
  }
  return JSON.stringify(output).slice(0, 240);
}

function renderToolStarted(event) {
  if (traceStepElement(event.stepNo, event.toolName)) return;
  const step = document.createElement("div");
  step.className = "trace-step is-running";
  step.id = `trace-step-${event.stepNo}-${String(event.toolName).replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;
  step.innerHTML = `
    <span class="trace-step-icon">${icon("sliders")}</span>
    <div>
      <strong>${escapeHtml(toolLabels[event.toolName] || event.toolName)}</strong>
      <p>${escapeHtml(event.inputSummary || "正在执行")}</p>
    </div>
    <span class="trace-step-state">执行中</span>`;
  $("#agent-trace-steps").append(step);
}

function renderToolCompleted(event) {
  let step = traceStepElement(event.stepNo, event.toolName);
  if (!step) {
    step = document.createElement("div");
    step.id = `trace-step-${event.stepNo}-${String(event.toolName).replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;
    $("#agent-trace-steps").append(step);
  }
  step.className = `trace-step${event.status === "failed" ? " is-error" : " is-complete"}`;
  const failed = event.status === "failed";
  const summary = event.outputSummary || summarizeToolOutput(event.output);
  const confirmationToken = event.output?.confirmationToken;
  const planPreview = event.output?.sessions?.length
    ? `<div class="plan-preview-list">${event.output.sessions
        .slice(0, 7)
        .map(
          (session) =>
            `<span><strong>${escapeHtml(session.date.slice(5))}</strong>${escapeHtml(
              session.workout?.title || "训练"
            )}</span>`
        )
        .join("")}</div>`
    : "";
  step.innerHTML = `
    <span class="trace-step-icon">${icon(failed ? "alert" : "check")}</span>
    <div>
      <strong>${escapeHtml(toolLabels[event.toolName] || event.toolName)}</strong>
      <p>${escapeHtml(summary)}</p>
      ${planPreview}
      ${
        confirmationToken
          ? `<button class="trace-confirm" type="button" data-confirm-plan="${escapeHtml(
              confirmationToken
            )}">确认写入训练日历</button>`
          : ""
      }
    </div>
    <span class="trace-step-state">${failed ? "失败" : "完成"}</span>`;
  step.dataset.rawOutput = JSON.stringify(event.output || {});
  if (confirmationToken && event.output) {
    state.planPreviews.set(confirmationToken, event.output);
    state.queuedPlanPreview = event.output;
  }
}

function resetPlanConfirmationState() {
  state.pendingPlanPreview = null;
  $("#plan-confirm-checkbox").checked = false;
  $("#plan-confirm-write").disabled = true;
}

function openPlanConfirmation(preview) {
  if (!preview?.confirmationToken) {
    toast("计划确认信息不完整，请重新生成", "error");
    return;
  }
  state.pendingPlanPreview = preview;
  state.planPreviews.set(preview.confirmationToken, preview);
  const targetLabel =
    preview.target === "coros" ? "高驰训练课程" : "本地训练日历";
  const days = preview.sessions?.length || preview.plan?.days?.length || 0;
  const conflictCount =
    preview.conflicts?.length ??
    (preview.sessions || []).filter((item) =>
      state.calendarSessions.some((session) => session.date === item.date)
    ).length;
  $("#plan-confirm-meta").innerHTML = `
    <div><span>写入目标</span><strong>${escapeHtml(targetLabel)}</strong></div>
    <div><span>计划长度</span><strong>${days} 天</strong></div>
    <div><span>现有安排</span><strong>${conflictCount} 天已有课程</strong></div>
    <p>${escapeHtml(preview.writeMode || "确认后写入训练计划。")}</p>`;
  $("#plan-confirm-list").innerHTML = (preview.sessions || [])
    .map(
      (session) => `
      <article>
        <time>${escapeHtml(session.date.slice(5))}</time>
        <div>
          <strong>${escapeHtml(session.workout?.title || "训练")}</strong>
          <small>${escapeHtml(session.workout?.volume || "")} · ${escapeHtml(
            session.workout?.effort || ""
          )}</small>
          <p>${escapeHtml(session.workout?.purpose || "")}</p>
        </div>
        <span>${session.workout?.corosEligible ? "高驰可写" : "仅本地"}</span>
      </article>`
    )
    .join("");
  $("#plan-confirm-checkbox").checked = false;
  $("#plan-confirm-write").disabled = true;
  openDialog("plan-confirm-dialog");
}

function closePlanConfirmation() {
  closeDialog("plan-confirm-dialog");
  resetPlanConfirmationState();
}

async function publishPendingPlan() {
  const preview = state.pendingPlanPreview;
  if (!preview?.confirmationToken) return;
  const button = $("#plan-confirm-write");
  button.disabled = true;
  try {
    const result = await api("/api/tools/publish-plan", {
      method: "POST",
      body: {
        confirmationToken: preview.confirmationToken,
        runId: state.currentRunId
      }
    });
    state.planPreviews.delete(preview.confirmationToken);
    $$("[data-confirm-plan]").forEach((button) => {
      if (button.dataset.confirmPlan !== preview.confirmationToken) return;
      button.textContent = "已写入训练日历";
      button.disabled = true;
      button.classList.add("is-complete");
    });
    state.pendingPlanPreview = null;
    closePlanConfirmation();
    hideRunTrace({ clear: true });
    toast(result.message || "训练计划已写入");
    await loadCalendar();
    if (preview.target === "coros") {
      await loadCorosStatus().catch(() => {});
    }
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
}

async function generateCalendarPlan() {
  const target = $("#calendar-plan-target").value;
  if (target === "coros" && !state.coros?.connected) {
    toast("请先连接高驰账号", "error");
    openCorosDialog();
    return;
  }
  const button = $("#calendar-generate");
  button.disabled = true;
  button.innerHTML = `${icon("refresh")}生成中...`;
  try {
    const preview = await api("/api/tools/preview-plan-write", {
      method: "POST",
      body: {
        startDate: state.calendarStart,
        target
      }
    });
    openPlanConfirmation(preview);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("spark")}AI 生成计划`;
  }
}

function finishRun({ retryable = true } = {}) {
  state.chatBusy = false;
  $(".send-button").disabled = false;
  $("#cancel-run").hidden = true;
  $("#retry-run").hidden = !retryable;
  state.runEventSource?.close();
  state.runEventSource = null;
  updateDebugVisibility();
}

function connectRunEvents(runId) {
  state.runEventSource?.close();
  const source = new EventSource(
    `/api/agent/runs/${encodeURIComponent(runId)}/events`
  );
  state.runEventSource = source;
  let recoveryTimer = null;
  let recoveryAttempts = 0;

  const isDuplicateEvent = (event) => {
    if (!event.lastEventId) return false;
    if (state.seenRunEventIds.has(event.lastEventId)) return true;
    state.seenRunEventIds.add(event.lastEventId);
    return false;
  };

  source.addEventListener("run.started", (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    setRunStage("queued");
    $("#agent-run-meta").textContent = data.model
      ? `${data.model}${data.contextUsage ? ` · 约 ${data.contextUsage.budget} tokens 预算` : ""}`
      : "";
  });

  source.addEventListener("stage.changed", (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    setRunStage(data.stage);
  });

  source.addEventListener("tool.started", (event) => {
    if (isDuplicateEvent(event)) return;
    renderToolStarted(JSON.parse(event.data));
  });

  source.addEventListener("tool.completed", (event) => {
    if (isDuplicateEvent(event)) return;
    renderToolCompleted(JSON.parse(event.data));
  });

  source.addEventListener("message.delta", (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    const wasNearBottom = state.chatPinnedBottom || isChatNearBottom();
    $("#typing-message")?.remove();
    if (!$("#streaming-message")) {
      const article = appendChatMessage(
        "assistant",
        data.content,
        data.model || activeModelLabel(),
        { wasNearBottom }
      );
      article.id = "streaming-message";
    }
  });

  source.addEventListener("run.completed", async (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    const completedRunId = data.runId || runId;
    const preview = state.queuedPlanPreview;
    state.queuedPlanPreview = null;
    setRunStage("completed");
    $("#agent-run-meta").textContent = data.fallback
      ? `本地保底 · ${data.fallbackReason || "模型未返回有效内容"}`
      : `${data.model || activeModelLabel()} · ${
          data.usage?.durationMs || 0
        } ms · 约 ${data.usage?.estimatedTotalTokens || 0} tokens`;
    if (data.fallback) {
      toast("模型未返回有效内容，已使用本地训练分析保底");
    }
    finishRun({ retryable: false });
    if (preview) openPlanConfirmation(preview);
    window.setTimeout(() => {
      if (state.currentRunId === completedRunId && !state.chatBusy) {
        hideRunTrace({ clear: true });
      }
    }, 900);
    $("#streaming-message")?.removeAttribute("id");
    await refreshSessionMeta();
  });

  source.addEventListener("run.failed", (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    $("#typing-message")?.remove();
    setRunStage("failed");
    $("#agent-run-meta").textContent = data.error || "运行失败";
    finishRun({ retryable: true });
    toast(data.error || "Agent 运行失败", "error");
  });

  source.addEventListener("run.cancelled", (event) => {
    if (isDuplicateEvent(event)) return;
    const data = JSON.parse(event.data);
    $("#typing-message")?.remove();
    setRunStage("cancelled");
    $("#agent-run-meta").textContent = data.error || "运行已停止";
    finishRun({ retryable: true });
  });

  source.addEventListener("error", () => {
    if (source !== state.runEventSource || !state.chatBusy || recoveryTimer) {
      return;
    }
    setRunStage("reconnecting");
    const recover = async () => {
      recoveryTimer = null;
      if (source !== state.runEventSource || !state.chatBusy) return;
      recoveryAttempts += 1;
      try {
        const { run } = await api(
          `/api/agent/runs/${encodeURIComponent(runId)}`
        );
        if (["completed", "failed", "cancelled"].includes(run.status)) {
          source.close();
          state.runEventSource = null;
          if (run.sessionId === state.currentSessionId) {
            await loadCurrentSession();
          }
          finishRun({ retryable: run.status !== "completed" });
          const previewStep = [...(run.steps || [])]
            .reverse()
            .find(
              (step) =>
                step.type === "tool" &&
                step.toolName === "previewPlanWrite" &&
                step.output?.confirmationToken
            );
          if (run.status === "completed" && previewStep?.output) {
            openPlanConfirmation(previewStep.output);
          }
          toast(
            run.status === "completed"
              ? "连接中断，已从运行记录恢复结果"
              : "连接中断，已读取运行状态",
            run.status === "completed" ? "success" : "error"
          );
          return;
        }
      } catch {
        // Keep retrying while the run may still be alive.
      }
      if (recoveryAttempts < 20) {
        recoveryTimer = window.setTimeout(recover, 3000);
      }
    };
    recoveryTimer = window.setTimeout(recover, 1500);
  });
}

async function sendQuestion(question) {
  const text = String(question || "").trim();
  if (!text || state.chatBusy) return;
  if (!requireModelReady()) return;
  if (!state.currentSessionId) {
    await createNewSession();
  }
  state.chatBusy = true;
  $("#chat-input").value = "";
  $(".send-button").disabled = true;
  appendChatMessage("user", text, "你");
  appendTyping();
  try {
    const result = await api("/api/agent/runs", {
      method: "POST",
      body: {
        question: text,
        sessionId: state.currentSessionId,
        model: state.model
      }
    });
    resetRunTrace(result.runId);
    connectRunEvents(result.runId);
  } catch (error) {
    $("#typing-message")?.remove();
    state.chatBusy = false;
    $(".send-button").disabled = false;
    if (error.code === "NETWORK_UNREACHABLE") {
      $("#chat-input").value = text;
    }
    toast(error.message, "error");
  }
}

async function cancelCurrentRun() {
  if (!state.currentRunId) return;
  try {
    await api(`/api/agent/runs/${encodeURIComponent(state.currentRunId)}/cancel`, {
      method: "POST"
    });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function retryCurrentRun() {
  if (!state.currentRunId) return;
  state.chatBusy = true;
  $(".send-button").disabled = true;
  try {
    const result = await api(
      `/api/agent/runs/${encodeURIComponent(state.currentRunId)}/retry`,
      { method: "POST", body: { model: state.model } }
    );
    $("#retry-run").hidden = true;
    appendTyping();
    resetRunTrace(result.runId);
    connectRunEvents(result.runId);
  } catch (error) {
    state.chatBusy = false;
    $(".send-button").disabled = false;
    toast(error.message, "error");
  }
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog?.open) dialog.close();
}

function settleActionDialog(value) {
  const resolve = state.actionResolver;
  state.actionResolver = null;
  closeDialog("action-dialog");
  if (resolve) resolve(value);
}

function openActionDialog({
  kicker = "操作确认",
  title = "确认继续",
  message = "",
  confirmLabel = "确认",
  danger = false,
  input = null
} = {}) {
  if (state.actionResolver) settleActionDialog(null);
  $("#action-kicker").textContent = kicker;
  $("#action-title").textContent = title;
  $("#action-message").textContent = message;
  $("#action-confirm").textContent = confirmLabel;
  $("#action-confirm").classList.toggle("is-danger", danger);
  $("#action-symbol").classList.toggle("is-danger", danger);
  const inputField = $("#action-input-field");
  const inputElement = $("#action-input");
  inputField.hidden = !input;
  if (input) {
    $("#action-input-label").textContent = input.label || "内容";
    inputElement.value = input.value || "";
    inputElement.placeholder = input.placeholder || "";
  }
  openDialog("action-dialog");
  window.requestAnimationFrame(() => {
    if (input) {
      inputElement.focus();
      inputElement.select();
    } else {
      $("#action-confirm").focus();
    }
  });
  return new Promise((resolve) => {
    state.actionResolver = resolve;
  });
}

async function confirmAction(message, options = {}) {
  const result = await openActionDialog({
    kicker: options.kicker || "操作确认",
    title: options.title || "确认继续",
    message,
    confirmLabel: options.confirmLabel || "确认",
    danger: options.danger ?? false
  });
  return result === true;
}

async function promptAction(message, options = {}) {
  const result = await openActionDialog({
    kicker: options.kicker || "编辑内容",
    title: options.title || "输入新内容",
    message,
    confirmLabel: options.confirmLabel || "保存",
    input: {
      label: options.label || "内容",
      value: options.value || "",
      placeholder: options.placeholder || ""
    }
  });
  return typeof result === "string" ? result.trim() : "";
}

function selectFile(file) {
  if (!file) return;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["csv", "gpx", "tcx"].includes(extension)) {
    toast("请选择 CSV、GPX 或 TCX 文件", "error");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast("文件不能超过 10 MB", "error");
    return;
  }
  state.selectedFile = file;
  $("#file-selection").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  $("#upload-submit").disabled = false;
}

function showImportResult(payload) {
  const result = $("#import-result");
  result.hidden = false;
  result.className = "import-result";
  const skippedText = payload.skipped ? `，跳过 ${payload.skipped} 条重复记录` : "";
  const failedText = payload.failed ? `，${payload.failed} 行未导入` : "";
  result.innerHTML = `<strong>导入完成</strong>成功导入 ${payload.imported} 条活动${skippedText}${failedText}。`;
}

async function loadImports() {
  const data = await api("/api/imports");
  state.imports = data.imports;
  renderImports();
}

function renderImports() {
  const list = $("#import-list");
  if (!state.imports.length) {
    list.innerHTML = `<p class="empty-copy">还没有导入记录。</p>`;
    return;
  }
  list.innerHTML = state.imports
    .map(
      (item) => `
      <div class="import-row">
        ${icon("file")}
        <span>
          <strong>${escapeHtml(item.filename)}</strong>
          <small>${escapeHtml(item.format.toUpperCase())} · ${formatDate(item.createdAt, true)} · ${item.importedCount} 条</small>
        </span>
        <button type="button" data-delete-import="${escapeHtml(item.id)}" title="删除这次导入">
          ${icon("trash")}
        </button>
      </div>`
    )
    .join("");
}

async function handleUpload(event) {
  event.preventDefault();
  if (!state.selectedFile) return;
  const button = $("#upload-submit");
  button.disabled = true;
  button.textContent = "正在解析...";
  const formData = new FormData();
  formData.append("file", state.selectedFile);

  try {
    const result = await api("/api/imports/files", {
      method: "POST",
      body: formData
    });
    showImportResult(result);
    toast(`成功导入 ${result.imported} 条跑步记录`);
    state.selectedFile = null;
    $("#file-input").value = "";
    $("#file-selection").textContent = "支持 CSV、GPX、TCX";
    await Promise.all([refreshDashboard(), loadImports()]);
  } catch (error) {
    const result = $("#import-result");
    result.hidden = false;
    result.className = "import-result is-error";
    result.textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.innerHTML = `${icon("upload")}开始导入`;
    button.disabled = !state.selectedFile;
  }
}

async function deleteImport(id) {
  if (
    !(await confirmAction("这次导入以及它生成的活动记录会被删除，此操作无法撤销。", {
      kicker: "数据导入",
      title: "删除这次导入？",
      confirmLabel: "删除导入",
      danger: true
    }))
  ) {
    return;
  }
  try {
    await api(`/api/imports/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("导入记录已删除");
    await Promise.all([refreshDashboard(), loadImports()]);
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindEvents() {
  $("#auth-form").addEventListener("submit", submitAuthentication);
  $("#action-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const inputField = $("#action-input-field");
    settleActionDialog(inputField.hidden ? true : $("#action-input").value.trim());
  });
  $("#action-cancel").addEventListener("click", () => settleActionDialog(null));
  $("#action-close").addEventListener("click", () => settleActionDialog(null));
  $("#action-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    settleActionDialog(null);
  });
  $("#open-model").addEventListener("click", openModelSettings);
  $("#rail-settings").addEventListener("click", openModelSettings);
  $("#coach-open-model").addEventListener("click", openModelSettings);
  $("#open-memory").addEventListener("click", openMemoryDialog);
  $("#new-session").addEventListener("click", () => {
    createNewSession().catch((error) => toast(error.message, "error"));
  });
  $("#session-list").addEventListener("click", (event) => {
    const select = event.target.closest("[data-session-id]");
    const rename = event.target.closest("[data-session-rename]");
    const remove = event.target.closest("[data-session-delete]");
    if (select) selectSession(select.dataset.sessionId).catch((error) => toast(error.message, "error"));
    if (rename) renameSession(rename.dataset.sessionRename).catch((error) => toast(error.message, "error"));
    if (remove) removeSession(remove.dataset.sessionDelete).catch((error) => toast(error.message, "error"));
  });
  $("#profile-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveProfile().catch((error) => toast(error.message, "error"));
  });
  $("#memory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMemory().catch((error) => toast(error.message, "error"));
  });
  $("#memory-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-memory-edit]");
    const remove = event.target.closest("[data-memory-delete]");
    if (edit) editMemory(edit.dataset.memoryEdit).catch((error) => toast(error.message, "error"));
    if (remove) removeMemory(remove.dataset.memoryDelete).catch((error) => toast(error.message, "error"));
  });
  $("#debug-mode").addEventListener("change", (event) => {
    state.debugMode = event.target.checked;
    localStorage.setItem("stride-os-debug", state.debugMode ? "1" : "0");
    updateDebugVisibility();
  });
  $("#cancel-run").addEventListener("click", cancelCurrentRun);
  $("#retry-run").addEventListener("click", retryCurrentRun);
  $("#open-context-debug").addEventListener("click", openContextDebug);
  $("#dismiss-trace").addEventListener("click", () =>
    hideRunTrace({ clear: true })
  );
  $("#agent-trace-steps").addEventListener("click", (event) => {
    const button = event.target.closest("[data-confirm-plan]");
    if (button) {
      const preview = state.planPreviews.get(button.dataset.confirmPlan);
      if (preview) openPlanConfirmation(preview);
      else toast("计划预览已失效，请重新生成", "error");
    }
  });
  $("#plan-confirm-checkbox").addEventListener("change", (event) => {
    $("#plan-confirm-write").disabled = !event.target.checked;
  });
  $("#plan-confirm-write").addEventListener("click", () => {
    publishPendingPlan().catch((error) => toast(error.message, "error"));
  });
  $("#plan-confirm-dialog").addEventListener("close", resetPlanConfirmationState);
  $("#provider-select").addEventListener("change", fillProviderPreset);
  $("#test-model").addEventListener("click", testModelFromForm);

  $("#model-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.model = readModelForm();
    saveModelConfig(state.model);
    updateModelUI();
    closeDialog("model-dialog");
    toast("模型配置已保存");
  });

  $$(".dialog-close").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.dataset.close));
  });

  const openUpload = () => {
    Promise.all([loadImports(), loadCorosStatus()]).catch((error) =>
      toast(error.message, "error")
    );
    openDialog("upload-dialog");
  };
  $("#open-upload").addEventListener("click", openUpload);
  $("#hero-upload").addEventListener("click", openUpload);
  $("#quick-upload").addEventListener("click", openUpload);
  $("#source-upload").addEventListener("click", openUpload);
  $("#upload-open-coros").addEventListener("click", () => {
    closeDialog("upload-dialog");
    openCorosDialog();
  });
  $("#source-list").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-coros]")) openCorosDialog();
  });
  $("#coros-connect").addEventListener("click", connectCoros);
  $("#coros-sync").addEventListener("click", syncCoros);
  $("#coros-inspect").addEventListener("click", inspectCoros);
  $("#coros-disconnect").addEventListener("click", disconnectCorosAccount);

  $("#file-input").addEventListener("change", (event) => selectFile(event.target.files?.[0]));
  $("#upload-form").addEventListener("submit", handleUpload);

  const dropZone = $("#drop-zone");
  ["dragenter", "dragover"].forEach((name) => {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  });
  dropZone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files?.[0]));

  $("#import-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-import]");
    if (button) deleteImport(button.dataset.deleteImport);
  });

  $$(".segmented button").forEach((button) => {
    button.addEventListener("click", async () => {
      $$(".segmented button").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      state.range = Number(button.dataset.range);
      try {
        await refreshDashboard();
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  $("#load-chart").addEventListener("pointerover", (event) => {
    const point = event.target.closest("[data-chart-x]");
    if (point) showTrendTooltip(point);
  });
  $("#load-chart").addEventListener("pointerleave", () => {
    const tooltip = $("#chart-tooltip");
    if (tooltip) tooltip.hidden = true;
  });
  $("#load-chart").addEventListener("focusin", (event) => {
    const point = event.target.closest("[data-chart-x]");
    if (point) showTrendTooltip(point);
  });
  $("#load-chart").addEventListener("focusout", (event) => {
    if ($("#load-chart").contains(event.relatedTarget)) return;
    const tooltip = $("#chart-tooltip");
    if (tooltip) tooltip.hidden = true;
  });

  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendQuestion($("#chat-input").value);
  });
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendQuestion($("#chat-input").value);
    }
  });
  $("#chat-stream").addEventListener("scroll", () => {
    state.chatPinnedBottom = isChatNearBottom();
  });
  $("#chat-stream").addEventListener("click", (event) => {
    const copy = event.target.closest("[data-copy-message]");
    if (copy) copyChatMessage(copy).catch((error) => toast(error.message, "error"));
  });
  $("#suggestion-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-question]");
    if (button) sendQuestion(button.dataset.question);
  });
  $("#clear-chat").addEventListener("click", async () => {
    if (state.chatBusy) {
      toast("当前回答正在运行，请先等待完成或停止运行", "error");
      return;
    }
    try {
      await api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/messages`, {
        method: "DELETE"
      });
      hideRunTrace({ clear: true });
      renderChatMessages([]);
      await loadCurrentSession();
      toast("对话已清空");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#reset-demo").addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "当前所有活动和导入记录会被删除，但会话、长期记忆和跑者档案会保留。",
        {
          kicker: "演示数据",
          title: "恢复演示数据？",
          confirmLabel: "恢复演示数据",
          danger: true
        }
      ))
    ) {
      return;
    }
    try {
      await api("/api/demo/reset", { method: "POST" });
      await refreshDashboard();
      toast("演示数据已恢复");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#calendar-prev").addEventListener("click", () => {
    const date = new Date(`${state.calendarStart}T12:00:00`);
    date.setDate(date.getDate() - 7);
    loadCalendar(isoDate(date)).catch((error) => toast(error.message, "error"));
  });
  $("#calendar-next").addEventListener("click", () => {
    const date = new Date(`${state.calendarStart}T12:00:00`);
    date.setDate(date.getDate() + 7);
    loadCalendar(isoDate(date)).catch((error) => toast(error.message, "error"));
  });
  $("#calendar-today").addEventListener("click", () => {
    loadCalendar().catch((error) => toast(error.message, "error"));
  });
  $("#calendar-generate").addEventListener("click", () => {
    generateCalendarPlan().catch((error) => toast(error.message, "error"));
  });
  $("#calendar-grid").addEventListener("click", async (event) => {
    const complete = event.target.closest("[data-calendar-complete]");
    const skip = event.target.closest("[data-calendar-skip]");
    if (!complete && !skip) return;
    const id = complete?.dataset.calendarComplete || skip.dataset.calendarSkip;
    const rpeInput = $(`[data-calendar-rpe="${CSS.escape(id)}"]`);
    try {
      await api(`/api/training/calendar/${encodeURIComponent(id)}/check-in`, {
        method: "POST",
        body: {
          status: complete ? "completed" : "skipped",
          rpe: rpeInput?.value || null,
          notes: ""
        }
      });
      await loadCalendar(state.calendarStart);
      toast(complete ? "训练已标记完成" : "训练已跳过");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $$("[data-route]").forEach((button) => {
    button.addEventListener("click", () => {
      navigate(button.dataset.route);
    });
  });

  $("#activity-search").addEventListener("input", (event) => {
    state.activityFilters.query = event.target.value;
    renderActivities();
  });
  $("#activity-distance-filter").addEventListener("change", (event) => {
    state.activityFilters.distance = event.target.value;
    renderActivities();
  });
  $("#activity-source-filter").addEventListener("change", (event) => {
    state.activityFilters.source = event.target.value;
    renderActivities();
  });
  $("#activity-sort").addEventListener("change", (event) => {
    state.activityFilters.sort = event.target.value;
    renderActivities();
  });
  $("#activity-reset").addEventListener("click", () => {
    state.activityFilters = {
      query: "",
      distance: "all",
      source: "all",
      sort: "latest"
    };
    $("#activity-search").value = "";
    $("#activity-distance-filter").value = "all";
    $("#activity-source-filter").value = "all";
    $("#activity-sort").value = "latest";
    renderActivities();
  });
  $("#activity-body").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-compare-id]");
    if (!checkbox) return;
    toggleActivityComparison(checkbox.dataset.compareId, checkbox.checked);
  });
  $("#activity-mobile-list").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-compare-id]");
    if (!checkbox) return;
    event.stopPropagation();
    toggleActivityComparison(checkbox.dataset.compareId, checkbox.checked);
  });
  $("#activity-mobile-list").addEventListener("click", (event) => {
    const action = event.target.closest("[data-activity-action]");
    if (action) {
      event.stopPropagation();
      const handler =
        action.dataset.activityAction === "rename"
          ? renameActivityRecord
          : deleteActivityRecord;
      handler(action.dataset.activityId).catch((error) =>
        toast(error.message, "error")
      );
      return;
    }
    if (event.target.closest(".activity-compare-choice")) return;
    const card = event.target.closest("[data-activity-id]");
    if (card) navigate(`/activities/${encodeURIComponent(card.dataset.activityId)}`);
  });
  $("#activity-compare-summary").addEventListener("click", (event) => {
    if (!event.target.closest("#clear-activity-compare")) return;
    state.compareActivityIds = [];
    renderActivities();
  });
  $("#activity-body").addEventListener("click", (event) => {
    const action = event.target.closest("[data-activity-action]");
    if (action) {
      const handler =
        action.dataset.activityAction === "rename"
          ? renameActivityRecord
          : deleteActivityRecord;
      handler(action.dataset.activityId).catch((error) =>
        toast(error.message, "error")
      );
      return;
    }
    if (event.target.closest(".compare-column")) return;
    const row = event.target.closest("[data-activity-id]");
    if (row) navigate(`/activities/${encodeURIComponent(row.dataset.activityId)}`);
  });
  $("#activity-body").addEventListener("pointermove", (event) => {
    if (event.target.closest(".compare-column, .activity-row-actions")) {
      clearActivityHighlight();
      return;
    }
    const row = event.target.closest(".activity-row");
    if (!row) return;
    highlightActivity(row.dataset.activityId);
    showActivityHoverCard(row, event);
  });
  $("#activity-body").addEventListener("pointerleave", clearActivityHighlight);
  $("#activity-body").addEventListener("focusin", (event) => {
    if (event.target.closest(".compare-column, .activity-row-actions")) {
      clearActivityHighlight();
      return;
    }
    const row = event.target.closest(".activity-row");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    highlightActivity(row.dataset.activityId);
    showActivityHoverCard(row, {
      clientX: rect.right - 24,
      clientY: rect.top + Math.min(32, rect.height / 2)
    });
  });
  $("#activity-body").addEventListener("focusout", clearActivityHighlight);
  $("#activity-body").addEventListener("keydown", (event) => {
    if (event.target.matches("input, button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-activity-id]");
    if (!row) return;
    event.preventDefault();
    navigate(`/activities/${encodeURIComponent(row.dataset.activityId)}`);
  });
  $("#activity-back").addEventListener("click", () => navigate("/activities"));
  $("#activity-scatter").addEventListener("pointerover", (event) => {
    const point = event.target.closest(".scatter-point");
    if (!point) return;
    highlightActivity(point.dataset.activityId);
    showActivityPointTooltip(point);
  });
  $("#activity-scatter").addEventListener("pointerleave", () => {
    const tooltip = $("#activity-chart-tooltip");
    if (tooltip) tooltip.hidden = true;
    clearActivityHighlight();
  });
  $("#activity-scatter").addEventListener("focusin", (event) => {
    const point = event.target.closest(".scatter-point");
    if (!point) return;
    highlightActivity(point.dataset.activityId);
    showActivityPointTooltip(point);
  });
  $("#activity-scatter").addEventListener("focusout", () => {
    const tooltip = $("#activity-chart-tooltip");
    if (tooltip) tooltip.hidden = true;
    clearActivityHighlight();
  });
  $("#activity-scatter").addEventListener("click", (event) => {
    const point = event.target.closest(".scatter-point");
    if (point) navigate(`/activities/${encodeURIComponent(point.dataset.activityId)}`);
  });
  window.addEventListener("popstate", () => navigate(window.location.pathname, { push: false }));
}

async function boot() {
  bindEvents();
  initHeroParticles();
  initJourneyNavigation();
  updateModelUI();
  const initialPath = window.location.pathname;
  try {
    if (!(await checkAuthentication())) {
      navigate(initialPath, {
        push: false,
        replace: false,
        load: false,
        scroll: false
      });
      syncActiveJourney();
      return;
    }
    navigate(initialPath, {
      push: false,
      replace: false,
      scroll: false
    });
    await loadAll();
    if (initialPath !== "/") {
      window.requestAnimationFrame(() =>
        scrollToRoute(initialPath, { behavior: "auto" })
      );
    } else {
      syncActiveJourney();
    }
    const params = new URLSearchParams(window.location.search);
    const corosResult = params.get("coros");
    if (corosResult === "connected") {
      toast("高驰账号连接成功");
      openCorosDialog();
    } else if (corosResult === "error") {
      toast(params.get("reason") || "高驰授权失败", "error");
      openCorosDialog();
    }
    if (corosResult) {
      params.delete("coros");
      params.delete("region");
      params.delete("reason");
      const cleanUrl = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  } catch (error) {
    toast(error.message, "error");
    $("#today-copy").textContent = "无法连接本地服务";
  }
}

boot();
