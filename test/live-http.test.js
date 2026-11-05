import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountLiveRoutes } from "../src/live/http-routes.js";

test("Live HTTP routes require loopback origin and owner token before mutations", async (t) => {
    const app = express();
    app.use(express.json());
    const service = {
        snapshot: () => ({ status: "idle" }),
        start: async (sdp) => { assert.equal(sdp, "v=0"); return { control_token: "owner", sdp: "answer" }; },
        heartbeat: (token, options) => {
            if (token !== "owner") throw Object.assign(new Error("owner required"), { statusCode: 403 });
            assert.equal(options.started, true);
            return { status: "active" };
        },
        stop: async (token) => { assert.equal(token, "owner"); return { closeConfirmed: true }; },
    };
    mountLiveRoutes(app, { service, config: { allowedOrigins: ["http://localhost:3000"] } });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, origin = "http://localhost:3000") => fetch(url + route, { method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post("/api/live/session", { sdp: "v=0" }, "https://unexpected.invalid")).status, 403);
    assert.equal((await post("/api/live/session", { sdp: "v=0" }, null)).status, 403);
    const created = await post("/api/live/session", { sdp: "v=0" });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal((await post("/api/live/heartbeat", { token: "wrong" })).status, 403);
    assert.equal((await post("/api/live/heartbeat", { token: "owner", started: true })).status, 200);
    assert.equal((await post("/api/live/stop", { token: "owner" })).status, 200);
});
