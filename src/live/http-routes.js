function isLoopbackAddress(address) {
    if (typeof address !== "string") return false;
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
    const octets = ipv4.split(".");
    return octets.length === 4
        && octets[0] === "127"
        && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

export function mountLiveRoutes(app, { service, config, ready = Promise.resolve() }) {
    const guard = (req, res, next) => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) return res.status(403).json({ error: "Live is restricted to this PC" });
        const origin = req.headers.origin;
        if ((req.method !== "GET" && !origin) || (origin && !config.allowedOrigins.includes(origin))) {
            return res.status(403).json({ error: "Unexpected Live request origin" });
        }
        res.set("Cache-Control", "no-store");
        next();
    };
    const handle = (run) => async (req, res) => {
        try { await ready; await run(req, res); }
        catch (error) {
            res.status(error.statusCode ?? 502).json({ error: error.statusCode ? error.message : "Live operation failed" });
        }
    };
    app.get("/api/live/status", guard, handle(async (_req, res) => res.json(service.snapshot())));
    app.post("/api/live/session", guard, handle(async (req, res) => res.status(201).json(await service.start(req.body?.sdp))));
    app.post("/api/live/heartbeat", guard, handle(async (req, res) => res.json(service.heartbeat(req.body?.token,
        { started: req.body?.started === true }))));
    app.post("/api/live/stop", guard, handle(async (req, res) => res.json(await service.stop(req.body?.token))));
}
