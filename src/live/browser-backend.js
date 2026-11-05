export class BrowserBackend {
    constructor({ enqueue, send, loadInstructions, attachImage, cleanupImage, turns, pending, responseTimeoutMs }) {
        Object.assign(this, { enqueue, send, loadInstructions, attachImage, cleanupImage, turns, pending, responseTimeoutMs });
        this.bootstrapSent = false;
    }

    run(context, { image = null, valid = () => true } = {}) {
        let resolveResponse;
        let rejectResponse;
        const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
        response.catch(() => {});
        let timer;
        return this.enqueue(async () => {
            if (!valid()) throw new Error("Browser request expired before send");
            this.turns.register(context);
            this.pending.set(context.turn_id, { resolve: resolveResponse, reject: rejectResponse });
            const isValid = () => this.pending.has(context.turn_id) && valid();
            // Bootstrap and the first task share one submission and one correlated response.
            // A separate bootstrap message would start an unnecessary model response.
            const input = this.bootstrapSent ? context : { ...context,
                kernel_backend_bootstrap: { instructions: await this.loadInstructions() } };
            let temporaryFile;
            try {
                if (!isValid()) throw new Error("Browser request expired before send");
                if (image) temporaryFile = await this.attachImage(image);
                await this.send(input, { isValid });
                this.bootstrapSent = true;
            } finally {
                if (temporaryFile) this.cleanupImage(temporaryFile);
            }
            // Queueing, prompt insertion and attachment preparation are not model response time.
            // A very fast response may already have consumed the pending turn during send().
            if (this.pending.has(context.turn_id)) timer = setTimeout(() => {
                this.pending.delete(context.turn_id);
                this.turns.remove(context.turn_id);
                rejectResponse(new Error("Browser backend response timed out"));
            }, this.responseTimeoutMs);
        }).then(() => response).finally(() => {
            clearTimeout(timer);
            this.pending.delete(context.turn_id);
            this.turns.remove(context.turn_id);
        });
    }
}
