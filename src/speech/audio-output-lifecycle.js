export class AudioOutputLifecycle {
    constructor({ playbackCoordinator, captureCoordinator }) {
        this.playbackCoordinator = playbackCoordinator;
        this.captureCoordinator = captureCoordinator;
    }

    async begin({ kind, outputId, pauseCapture = true }) {
        const release = await this.playbackCoordinator.acquire({ kind, outputId });
        try {
            const capture = pauseCapture
                ? await this.captureCoordinator.pause({ reason: kind, outputId })
                : null;
            return { kind, outputId, pauseCapture, release, capture };
        } catch (error) {
            release();
            throw error;
        }
    }

    end(context) {
        if (!context) return;
        context.release();
        if (context.pauseCapture) {
            this.captureCoordinator.scheduleResume({ reason: `${context.kind}_finished` });
        }
    }
}
