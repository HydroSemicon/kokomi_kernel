const state = {
    snapshot: null,
    filter: "all",
    streamConnected: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const serviceNames = {
    kernel: "Kernel API",
    chatgpt: "ChatGPT ブリッジ",
    bme280: "環境センサー",
    brightness: "照度センサー",
    actuators: "アクチュエーター",
    vision: "ビジョン",
    faceMemory: "顔記憶",
    tts: "音声出力",
};

const statusLabels = {
    online: "正常",
    degraded: "要確認",
    offline: "切断",
    checking: "確認中",
    busy: "処理中",
    idle: "待機",
    disabled: "無効",
    error: "エラー",
    success: "成功",
};

const sensorDefinitions = [
    { key: "temperature", label: "気温", icon: "♨", unit: "°C", digits: 1 },
    { key: "humidity", label: "湿度", icon: "◌", unit: "%", digits: 1 },
    { key: "pressure", label: "気圧", icon: "↕", unit: "hPa", digits: 0 },
    { key: "brightness", label: "明るさ", icon: "☀", unit: "raw", digits: 0 },
];

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatClock(iso) {
    if (!iso) return "--:--:--";
    return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));
}

function formatRelative(iso) {
    if (!iso) return "未実行";
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 5) return "たった今";
    if (seconds < 60) return `${seconds}秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
    return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return "--";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}日 ${hours}時間`;
    if (hours) return `${hours}時間 ${minutes}分`;
    return `${minutes}分 ${seconds % 60}秒`;
}

function calculateSuccess(endpoints) {
    const calls = endpoints.reduce((sum, endpoint) => sum + endpoint.calls, 0);
    const errors = endpoints.reduce((sum, endpoint) => sum + endpoint.errors, 0);
    return calls === 0 ? 100 : Math.round(((calls - errors) / calls) * 100);
}

function renderHero(snapshot) {
    const unhealthy = snapshot.services.filter((service) => ["offline", "degraded"].includes(service.status));
    const kernelStatus = unhealthy.length ? "degraded" : "online";
    const chatgpt = snapshot.services.find((service) => service.id === "chatgpt");
    const dot = $("#kernel-dot");
    dot.className = `status-dot ${kernelStatus}`;
    $("#kernel-label").textContent = kernelStatus === "online" ? "システム正常" : `${unhealthy.length}件の要確認項目`;
    $("#kernel-description").textContent = kernelStatus === "online" ? "すべての主要コンポーネントが稼働しています" : "詳細を確認し、切断中のサービスを復旧してください";
    $("#uptime").textContent = formatUptime(snapshot.kernel.uptimeSeconds);
    $("#chatgpt-summary").textContent = statusLabels[chatgpt?.status] || "不明";
    $("#api-success").textContent = `${calculateSuccess(snapshot.endpoints)}%`;
    $("#last-update").textContent = formatClock(snapshot.generatedAt);
    $("#sidebar-port").textContent = `:${snapshot.kernel.port}`;
    $("#footer-version").textContent = `v${snapshot.kernel.version} · localhost:${snapshot.kernel.port}`;

    const banner = $("#alert-banner");
    if (unhealthy.length) {
        banner.hidden = false;
        banner.innerHTML = `<strong>${unhealthy.length}件の接続に問題があります。</strong> ${unhealthy.map((item) => escapeHtml(serviceNames[item.id] || item.label)).join("、")}を確認してください。`;
    } else {
        banner.hidden = true;
    }
}

function renderSensors(snapshot) {
    const sensors = snapshot.sensors;
    $("#sensor-grid").innerHTML = sensorDefinitions.map((sensor) => {
        const value = sensors[sensor.key];
        const available = typeof value === "number" && Number.isFinite(value);
        const formatted = available ? value.toFixed(sensor.digits) : "--";
        return `<article class="sensor-card">
            <div class="sensor-top"><span>${sensor.label}</span><span class="sensor-icon" aria-hidden="true">${sensor.icon}</span></div>
            <div class="sensor-value"><strong>${formatted}</strong><span>${sensor.unit}</span></div>
            <span class="sensor-state">${available ? "リアルタイム取得中" : "データ待機中"}</span>
        </article>`;
    }).join("");
    $("#sensor-updated").textContent = sensors.updatedAt ? `更新 ${formatRelative(sensors.updatedAt)}` : "サンプルを待っています";
}

function renderServices(snapshot) {
    const ordered = ["chatgpt", "bme280", "brightness", "actuators", "vision", "faceMemory", "tts"];
    const services = ordered.map((id) => snapshot.services.find((item) => item.id === id)).filter(Boolean);
    const healthy = services.filter((service) => ["online", "idle", "disabled"].includes(service.status)).length;
    $("#service-count").textContent = `${healthy}/${services.length} 利用可`;
    $("#service-list").innerHTML = services.map((service) => `<div class="service-row">
        <i class="status-dot ${escapeHtml(service.status)}"></i>
        <div class="service-name"><strong>${escapeHtml(serviceNames[service.id] || service.label)}</strong><span>${escapeHtml(statusLabels[service.status] || service.status)}</span></div>
        <span class="service-detail" title="${escapeHtml(service.detail)}">${escapeHtml(service.detail)}</span>
        <span class="latency">${Number.isFinite(service.latencyMs) ? `${service.latencyMs} ms` : "—"}</span>
    </div>`).join("");
}

function activityGlyph(item) {
    if (item.status === "error" || item.status === "offline") return "!";
    if (item.direction === "inbound") return "↓";
    if (item.direction === "outbound") return "↑";
    if (item.category === "control") return "◫";
    return "•";
}

function activityHtml(item, compact = false) {
    const payload = item.payload == null ? "" : `<details class="json-details"><summary>JSONペイロードを表示</summary><pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre></details>`;
    const direction = item.direction === "inbound" ? "受信" : item.direction === "outbound" ? "送信" : "";
    const meta = compact ? "" : `<div class="activity-meta">
        ${item.endpoint ? `<span>${escapeHtml(item.endpoint)}</span>` : ""}
        ${item.service ? `<span>${escapeHtml(serviceNames[item.service] || item.service)}</span>` : ""}
        ${Number.isFinite(item.durationMs) ? `<span>${item.durationMs} ms</span>` : ""}
    </div>`;
    return `<article class="activity-item ${escapeHtml(item.status)}" data-direction="${escapeHtml(item.direction || "")}" data-status="${escapeHtml(item.status)}">
        <span class="activity-glyph" aria-hidden="true">${activityGlyph(item)}</span>
        <div class="activity-main"><div class="activity-title"><strong>${escapeHtml(item.title)}</strong>${direction ? `<span class="direction">${direction}</span>` : ""}</div><p class="activity-summary">${escapeHtml(item.summary || "詳細情報なし")}</p>${meta}</div>
        <time class="activity-time" datetime="${escapeHtml(item.timestamp)}">${formatRelative(item.timestamp)}</time>
        ${compact ? "" : payload}
    </article>`;
}

function filteredActivity(activity) {
    if (state.filter === "all") return activity;
    if (state.filter === "error") return activity.filter((item) => ["error", "offline", "degraded"].includes(item.status));
    return activity.filter((item) => item.direction === state.filter);
}

function renderActivity(snapshot) {
    const activity = snapshot.activity || [];
    const preview = activity.slice(0, 5);
    $("#activity-preview").innerHTML = preview.length ? preview.map((item) => activityHtml(item, true)).join("") : '<div class="empty-state">まだイベントはありません</div>';
    const filtered = filteredActivity(activity);
    $("#activity-log").innerHTML = filtered.length ? filtered.map((item) => activityHtml(item)).join("") : '<div class="empty-state">条件に一致するイベントはありません</div>';
    $("#log-count").textContent = `${filtered.length}件`;

    $("#inbound-count").textContent = activity.filter((item) => item.direction === "inbound").length;
    $("#outbound-count").textContent = activity.filter((item) => item.direction === "outbound").length;
    $("#error-count").textContent = activity.filter((item) => ["error", "offline", "degraded"].includes(item.status)).length;

    if ($("#json-toggle").checked) {
        $$(".json-details").forEach((details) => { details.open = true; });
    }
}

function renderEndpoints(snapshot) {
    $("#endpoint-table").innerHTML = snapshot.endpoints.map((endpoint) => {
        const status = endpoint.health || "online";
        const lastResponse = endpoint.lastCalledAt
            ? `${endpoint.lastStatusCode} · ${endpoint.lastDurationMs} ms · ${formatRelative(endpoint.lastCalledAt)}`
            : "待機中";
        return `<tr>
            <td><span class="endpoint-status"><i class="status-dot ${escapeHtml(status)}"></i>${escapeHtml(statusLabels[status] || status)}</span></td>
            <td><span class="method">${escapeHtml(endpoint.method)}</span><code>${escapeHtml(endpoint.route)}</code></td>
            <td>${escapeHtml(endpoint.label)}</td>
            <td>${endpoint.calls}</td><td>${endpoint.errors}</td><td>${escapeHtml(lastResponse)}</td>
        </tr>`;
    }).join("");
}

function render(snapshot) {
    state.snapshot = snapshot;
    renderHero(snapshot);
    renderSensors(snapshot);
    renderServices(snapshot);
    renderActivity(snapshot);
    renderEndpoints(snapshot);
}

async function fetchSnapshot({ quiet = false } = {}) {
    const button = $("#refresh-button");
    if (!quiet) button.classList.add("spinning");
    try {
        const response = await fetch("/api/dashboard/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        render(await response.json());
    } catch (error) {
        if (!quiet) showToast("更新できませんでした", error.message, true);
    } finally {
        setTimeout(() => button.classList.remove("spinning"), 500);
    }
}

function connectEventStream() {
    const stream = new EventSource("/api/dashboard/events");
    const streamLabel = $("#stream-status");
    const liveDot = $(".live-dot");

    stream.addEventListener("open", () => {
        state.streamConnected = true;
        streamLabel.textContent = "ライブ接続";
        liveDot.classList.remove("offline");
    });
    stream.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
    stream.addEventListener("activity", (event) => {
        if (!state.snapshot) return;
        state.snapshot.activity.unshift(JSON.parse(event.data));
        state.snapshot.activity = state.snapshot.activity.slice(0, 60);
        renderActivity(state.snapshot);
    });
    stream.addEventListener("service", (event) => {
        if (!state.snapshot) return;
        const service = JSON.parse(event.data);
        const index = state.snapshot.services.findIndex((item) => item.id === service.id);
        if (index >= 0) state.snapshot.services[index] = service;
        state.snapshot.generatedAt = new Date().toISOString();
        renderHero(state.snapshot);
        renderServices(state.snapshot);
    });
    stream.addEventListener("sensors", (event) => {
        if (!state.snapshot) return;
        state.snapshot.sensors = JSON.parse(event.data);
        renderSensors(state.snapshot);
    });
    stream.onerror = () => {
        state.streamConnected = false;
        streamLabel.textContent = "再接続中";
        liveDot.classList.add("offline");
    };
}

async function postJson(url, payload, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "送信中…";
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function showToast(title, message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " error" : ""}`;
    toast.innerHTML = `<span aria-hidden="true">${isError ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
    $("#toast-region").append(toast);
    setTimeout(() => toast.remove(), 3800);
}

function bindForms() {
    $("#message-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = $("#message-input").value.trim();
        if (!text) return showToast("入力が必要です", "メッセージを入力してください", true);
        try {
            await postJson("/user_input", { text }, event.submitter || $("#message-form button"));
            $("#message-input").value = "";
            showToast("送信しました", "ChatGPTブリッジへ入力を渡しました");
        } catch (error) {
            showToast("送信に失敗しました", error.message, true);
        }
    });
    $("#message-input").addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key === "Enter") $("#message-form").requestSubmit();
    });

    const colorInput = $("#led-color");
    const hexInput = $("#led-hex");
    colorInput.addEventListener("input", () => { hexInput.value = colorInput.value.toUpperCase(); });
    hexInput.addEventListener("input", () => {
        if (/^#[0-9a-f]{6}$/i.test(hexInput.value)) colorInput.value = hexInput.value;
    });
    $$("[data-color]").forEach((button) => button.addEventListener("click", () => {
        colorInput.value = button.dataset.color;
        hexInput.value = button.dataset.color;
    }));
    $("#led-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const color = hexInput.value.toUpperCase();
        if (!/^#[0-9A-F]{6}$/.test(color)) return showToast("カラーを確認してください", "#RRGGBB形式で入力してください", true);
        try {
            await postJson("/api/dashboard/actions", { type: "led_change", params: { color } }, event.submitter);
            showToast("LEDを更新しました", color);
        } catch (error) {
            showToast("LED操作に失敗しました", error.message, true);
        }
    });

    const speed = $("#tear-speed");
    const duration = $("#tear-duration");
    speed.addEventListener("input", () => { $("#speed-value").textContent = speed.value; });
    duration.addEventListener("input", () => { $("#duration-value").textContent = duration.value; });
    $("#tear-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const params = { speed: Number(speed.value), duration: Number(duration.value) };
        try {
            await postJson("/api/dashboard/actions", { type: "tear", params }, event.submitter);
            showToast("涙機構を実行しました", `速度 ${params.speed} / 時間 ${params.duration}`);
        } catch (error) {
            showToast("機構操作に失敗しました", error.message, true);
        }
    });
}

function bindNavigation() {
    const links = $$(".nav-link");
    const sections = links.map((link) => $(link.getAttribute("href")));
    const observer = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        links.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
    }, { rootMargin: "-20% 0px -65%", threshold: [0, .2, .5] });
    sections.forEach((section) => section && observer.observe(section));

    $$(".filter").forEach((button) => button.addEventListener("click", () => {
        $$(".filter").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        state.filter = button.dataset.filter;
        if (state.snapshot) renderActivity(state.snapshot);
    }));

    $("#json-toggle").addEventListener("change", (event) => {
        $$(".json-details").forEach((details) => { details.open = event.target.checked; });
    });
    $("#refresh-button").addEventListener("click", () => fetchSnapshot());
}

function updateClock() {
    const now = new Date();
    $("#clock-time").textContent = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
    $("#clock-date").textContent = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    if (state.snapshot) {
        state.snapshot.kernel.uptimeSeconds = Math.floor((Date.now() - new Date(state.snapshot.kernel.startedAt).getTime()) / 1000);
        $("#uptime").textContent = formatUptime(state.snapshot.kernel.uptimeSeconds);
        $$(".activity-time").forEach((node) => { node.textContent = formatRelative(node.dateTime); });
    }
}

bindForms();
bindNavigation();
updateClock();
setInterval(updateClock, 1000);
fetchSnapshot();
connectEventStream();
setInterval(() => fetchSnapshot({ quiet: true }), 10000);
