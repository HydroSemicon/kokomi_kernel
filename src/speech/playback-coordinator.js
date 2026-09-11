export class PlaybackCoordinator {
    constructor() {
        this.tail = Promise.resolve();
        this.current = null;
        this.sequence = 0;
    }

    acquire({ kind, outputId }) {
        const order = ++this.sequence;
        let unlock;
        const gate = new Promise((resolve) => { unlock = resolve; });
        const previous = this.tail;
        this.tail = previous.catch(() => {}).then(() => gate);
        return previous.catch(() => {}).then(() => {
            let released = false;
            this.current = { order, kind, output_id: outputId, acquired_at: new Date().toISOString() };
            return () => {
                if (released) return;
                released = true;
                if (this.current?.order === order) this.current = null;
                unlock();
            };
        });
    }

    snapshot() {
        return this.current ? { busy: true, ...this.current } : { busy: false };
    }
}
