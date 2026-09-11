// Legacy entry point retained so old shortcuts fail with a useful message.
// Realtime Scribe token issuance now belongs to Alice Kernel; running a second
// server here would reintroduce the port-3000 collision.
console.error("realtime_stt.js is retired. Run `node alice.js` and open http://localhost:3000/asr instead.");
process.exitCode = 1;
