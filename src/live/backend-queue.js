// Serializes jobs within one lane so control turns cannot overtake one another.
export class BackendQueue {
    constructor() { this.pending = []; this.running = false; }
    submit(run, { priority = 0, valid = () => true } = {}) {
        return new Promise((resolve, reject) => {
            this.pending.push({ run, priority, valid, resolve, reject });
            this.pending.sort((a, b) => b.priority - a.priority);
            this.drain();
        });
    }
    async drain() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.pending.length) {
                const job = this.pending.shift();
                try {
                    if (!job.valid()) throw new Error("Backend request superseded");
                    job.resolve(await job.run());
                } catch (error) { job.reject(error); }
            }
        } finally { this.running = false; }
    }
}
