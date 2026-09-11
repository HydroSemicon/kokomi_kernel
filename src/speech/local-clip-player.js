export class LocalClipPlayer {
    constructor({ command = "ffplay", args = ["-nodisp", "-autoexit", "-loglevel", "quiet"], spawnImpl }) {
        this.command = command;
        this.args = args;
        this.spawnImpl = spawnImpl;
        this.current = null;
    }

    play({ outputId, filePath, onStarted = async () => {} }) {
        if (this.current) throw new Error("local clip player is already busy");
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = this.spawnImpl(this.command, [...this.args, filePath]);
            } catch {
                reject(new Error("local clip player could not be started"));
                return;
            }
            const playback = { outputId, child, cancelled: false, settled: false };
            let started = Promise.resolve();
            this.current = playback;
            const finish = (callback, value) => {
                if (playback.settled) return;
                playback.settled = true;
                if (this.current === playback) this.current = null;
                callback(value);
            };
            child.once("error", () => finish(reject, new Error("local clip player could not be started")));
            child.once("spawn", () => {
                started = Promise.resolve(onStarted());
            });
            child.once("close", (code) => {
                started.then(() => {
                    if (playback.cancelled) return finish(resolve, { status: "cancelled" });
                    if (code !== 0) return finish(reject, new Error(`local clip player exited with code ${code}`));
                    return finish(resolve, { status: "completed" });
                }, () => finish(reject, new Error("local clip playback start hook failed")));
            });
        });
    }

    stop(outputId = null) {
        const playback = this.current;
        if (!playback || (outputId && playback.outputId !== outputId)) return false;
        playback.cancelled = true;
        try {
            playback.child.kill();
        } catch {
            return false;
        }
        return true;
    }

    snapshot() {
        return this.current ? { playing: true, output_id: this.current.outputId } : { playing: false };
    }
}
