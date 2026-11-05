export class SilenceAlarm {
    prepare() {
        const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!this.context && AudioContextClass) this.context = new AudioContextClass();
        this.context?.resume().catch(() => {});
    }
    play() {
        const context = this.context;
        if (context?.state !== "running") return false;
        for (let index = 0; index < 2; index++) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const start = context.currentTime + index * 0.3;
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
            gain.gain.linearRampToValueAtTime(0, start + 0.2);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.22);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        }
        return true;
    }
    close() { this.context?.close().catch(() => {}); this.context = null; }
}

export class LiveAudioMonitor {
    constructor({ config = {}, clock = () => Date.now(), alarm = new SilenceAlarm(),
        onWarning = () => {}, playbackState = () => ({}) } = {}) {
        Object.assign(this, { config, clock, alarm, onWarning, playbackState });
        this.samples = [];
        this.previous = new Map();
    }
    prepare() {
        try { this.alarm.prepare(); } catch (error) { this.lastAlarmError = error.message; }
    }
    start(peer) {
        if (this.timer) return;
        this.peer = peer;
        this.lastActivity = this.clock();
        this.lastWarning = null;
        this.samples = [];
        this.previous.clear();
        this.timer = setInterval(() => this.sample(), this.config.audioStatsIntervalMs ?? 1000);
    }
    noteActivity() { this.lastActivity = this.clock(); this.lastWarning = null; }
    level(stat) {
        const previous = this.previous.get(stat.id);
        const duration = stat.totalAudioEnergy !== undefined && stat.totalSamplesDuration !== undefined
            ? stat.totalSamplesDuration - (previous?.totalSamplesDuration ?? 0) : null;
        if (duration !== null) return duration > 0
            ? Math.sqrt(Math.max(0, stat.totalAudioEnergy - (previous?.totalAudioEnergy ?? 0)) / duration) : 0;
        return stat.audioLevel ?? 0;
    }
    async sample() {
        if (!this.peer || this.sampling) return;
        const peer = this.peer;
        this.sampling = true;
        try {
            const report = await peer.getStats?.();
            if (peer !== this.peer) return;
            let microphone = 0;
            let speaker = 0;
            const incoming = [];
            for (const stat of report?.values() ?? []) {
                if ((stat.kind ?? stat.mediaType) !== "audio") continue;
                if (stat.type === "media-source") microphone = Math.max(microphone, this.level(stat));
                if (stat.type === "inbound-rtp") {
                    speaker = Math.max(speaker, this.level(stat));
                    const previous = this.previous.get(stat.id);
                    const delta = (field) => typeof stat[field] === "number" && typeof previous?.[field] === "number"
                        ? Math.max(0, stat[field] - previous[field]) : null;
                    const emitted = delta("jitterBufferEmittedCount");
                    incoming.push({ id: stat.id, packetsLost: stat.packetsLost ?? null,
                        lostDelta: delta("packetsLost"), discardedDelta: delta("packetsDiscarded"),
                        concealedDelta: delta("concealedSamples"), concealmentEventsDelta: delta("concealmentEvents"),
                        jitterMs: typeof stat.jitter === "number" ? stat.jitter * 1000 : null,
                        bufferMs: emitted && delta("jitterBufferDelay") !== null ? delta("jitterBufferDelay") / emitted * 1000 : null });
                }
                this.previous.set(stat.id, stat);
            }
            if (Math.max(microphone, speaker) >= (this.config.silenceAudioLevel ?? 0.02)) this.noteActivity();
            this.samples.push({ at: this.clock(), microphone, speaker, incoming, playback: this.playbackState() });
            if (this.samples.length > 180) this.samples.shift();
        } catch (error) { this.lastStatsError = error.message; }
        finally {
            this.sampling = false;
            if (peer === this.peer) this.checkSilence();
        }
    }
    checkSilence() {
        const now = this.clock();
        const silenceMs = (this.config.silenceWarningSeconds ?? 60) * 1000;
        if (!this.peer || now - this.lastActivity < silenceMs) return;
        if (this.lastWarning !== null && now - this.lastWarning < (this.config.silenceWarningRepeatSeconds ?? 60) * 1000) return;
        this.lastWarning = now;
        let soundPlayed = false;
        try { soundPlayed = this.alarm.play(); } catch (error) { this.lastAlarmError = error.message; }
        this.onWarning({ silentSeconds: Math.floor((now - this.lastActivity) / 1000), soundPlayed });
    }
    snapshot() {
        return { samples: [...this.samples], lastStatsError: this.lastStatsError ?? null, lastAlarmError: this.lastAlarmError ?? null,
            silenceSeconds: this.peer ? Math.floor((this.clock() - this.lastActivity) / 1000) : null };
    }
    stop() {
        clearInterval(this.timer);
        this.timer = null;
        this.peer = null;
        this.alarm.close();
    }
}
