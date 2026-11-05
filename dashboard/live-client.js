import { LiveAudioMonitor } from "./live-audio-monitor.js";

export class LiveBrowserClient {
    constructor({ fetchImpl = (...args) => fetch(...args), mediaDevices = globalThis.navigator?.mediaDevices,
        peerFactory = () => new RTCPeerConnection(), audioFactory = () => new Audio(),
        onStatus = () => {}, onTranscript = () => {}, onSilenceWarning = () => {}, config = {}, audioMonitor = null } = {}) {
        Object.assign(this, { fetchImpl, mediaDevices, peerFactory, audioFactory, onStatus, onTranscript, config });
        this.generation = 0;
        this.active = false;
        this.starting = false;
        this.audioMonitor = audioMonitor ?? new LiveAudioMonitor({ config, onWarning: onSilenceWarning,
            playbackState: () => ({ paused: this.audio?.paused, muted: this.audio?.muted, readyState: this.audio?.readyState }) });
    }

    async request(route, body) {
        const response = await this.fetchImpl(route, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Live request failed");
        return result;
    }

    async start() {
        if (this.starting || this.active || this.closing || this.owner) return;
        const generation = ++this.generation;
        this.sessionStarted = false;
        this.starting = true;
        this.onStatus("connecting", "Live へ接続中");
        this.audioMonitor.config = this.config;
        this.audioMonitor.prepare(); // The start button's user gesture also unlocks the local warning sound.
        let owner = null;
        try {
            const stream = await this.mediaDevices.getUserMedia({ audio: {
                echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            } });
            if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
            this.stream = stream;
            const peer = this.peerFactory();
            this.peer = peer;
            this.audio = this.audioFactory();
            this.audio.autoplay = true;
            peer.ontrack = (event) => {
                if (generation !== this.generation || !this.audio) return;
                this.audio.srcObject = event.streams[0];
                this.resumeAudio();
            };
            peer.onconnectionstatechange = () => {
                if (generation !== this.generation) return;
                if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
                    this.stop().finally(() => this.onStatus("error", "音声接続が切れました。開始ボタンで再接続できます。"));
                }
            };
            for (const track of stream.getTracks()) peer.addTrack(track, stream);
            const channel = peer.createDataChannel("oai-events");
            this.channel = channel;
            channel.onmessage = ({ data }) => {
                if (generation !== this.generation) return;
                let event;
                try { event = JSON.parse(data); } catch { return; }
                if (event.type === "session.started") {
                    this.sessionStarted = true;
                    this.active = true;
                    this.audioMonitor.start(peer);
                    this.onStatus("active", "会話中 — 終了ボタンで切断できます");
                    if (this.owner) this.sendHeartbeat(generation, this.owner);
                } else if (event.type.endsWith("_transcript.delta")) {
                    if (event.delta?.trim()) this.audioMonitor.noteActivity();
                    this.onTranscript(event.type.includes("input_") ? "user" : "assistant", event.delta ?? "");
                } else if (event.type === "error") {
                    const code = typeof event.error?.code === "string" ? event.error.code.slice(0, 200) : "unknown";
                    const message = typeof event.error?.message === "string" ? event.error.message
                        .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/giu, "[redacted]").slice(0, 1000) : "イベントが拒否されました";
                    this.onStatus("warning", `Live 警告 (${code}): ${message}`);
                } else if (event.type === "session.closed") {
                    this.stop().finally(() => this.onStatus("error", "Live セッションが終了しました"));
                }
            };
            await peer.setLocalDescription(await peer.createOffer());
            await this.waitForIce(peer);
            if (generation !== this.generation) return;
            owner = await this.request("/api/live/session", { sdp: peer.localDescription.sdp });
            if (generation !== this.generation) {
                await this.request("/api/live/stop", { token: owner.control_token });
                return;
            }
            this.owner = owner;
            await peer.setRemoteDescription({ type: "answer", sdp: owner.sdp });
            if (generation !== this.generation) return;
            this.heartbeatTimer = setInterval(() => this.sendHeartbeat(generation, owner), owner.heartbeat_interval_ms);
        } catch (error) {
            if (generation !== this.generation) return;
            if (generation === this.generation) {
                if (owner) this.owner = owner;
                await this.stop();
                this.onStatus("error", error.message);
            }
            throw error;
        } finally {
            if (generation === this.generation) this.starting = false;
        }
    }

    async sendHeartbeat(generation, owner) {
        try {
            const status = await this.request("/api/live/heartbeat", { token: owner.control_token, started: this.sessionStarted });
            if (generation !== this.generation) return;
            if (["error", "idle"].includes(status.status)) throw new Error(status.lastError || "Session ended");
            if (status.contextWarning) this.onStatus("warning", status.contextWarning);
        } catch {
            if (generation === this.generation) {
                await this.stop();
                this.onStatus("error", "Live 接続を確認できません。再接続してください。");
            }
        }
    }

    waitForIce(peer) {
        if (peer.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { cleanup(); reject(new Error("ICE negotiation timed out")); },
                this.config.iceTimeoutMs ?? 10000);
            const cleanup = () => { clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", check); };
            const check = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
            peer.addEventListener("icegatheringstatechange", check);
            check();
        });
    }

    async resumeAudio() {
        try {
            this.audioMonitor.prepare();
            await this.audio?.play();
            if (this.active) this.onStatus("active", "会話中 — 終了ボタンで切断できます");
        }
        catch { this.onStatus("playback_blocked", "「音声再生を許可」を押してください"); }
    }

    release() {
        this.audioMonitor.stop();
        clearInterval(this.heartbeatTimer);
        this.channel?.close();
        this.peer?.close();
        this.stream?.getTracks().forEach((track) => track.stop());
        this.audio?.pause();
        if (this.audio) this.audio.srcObject = null;
        this.peer = this.channel = this.stream = this.audio = null;
    }

    diagnostics() { return this.audioMonitor.snapshot(); }

    async stop() {
        if (this.closing) return;
        this.closing = true;
        ++this.generation;
        this.active = this.starting = false;
        const owner = this.owner;
        this.owner = null;
        this.release(); // Stop microphone and audible output immediately, before network cleanup.
        this.onStatus("closing", "会話を終了中");
        try {
            if (owner) {
                const status = await this.request("/api/live/stop", { token: owner.control_token });
                if (!status.closeConfirmed) throw new Error("終了確認を取得できませんでした。接続状態を確認してください。");
            }
            this.onStatus("idle", "会話は停止しています");
        } catch (error) {
            this.owner = owner; // Keep the owner token so an unconfirmed close can be retried.
            this.onStatus("error", error.message);
        } finally { this.closing = false; }
    }

    pageHide(navigatorObject = globalThis.navigator) {
        const token = this.owner?.control_token;
        ++this.generation;
        this.release();
        if (token) navigatorObject.sendBeacon("/api/live/stop", new Blob([JSON.stringify({ token })], { type: "application/json" }));
    }
}
