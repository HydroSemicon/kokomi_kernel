export function bodyContext(snapshot, { intoxicationSignal, quantization }) {
    const describe = (fact, step, unit = "") => {
        if (fact?.status !== "known") return fact?.status ?? "unknown";
        const value = step && typeof fact.value === "number"
            ? Math.round(fact.value / step) * step : fact.value;
        return `${value}${unit}`;
    };
    const environment = snapshot.state.environment;
    const people = snapshot.state.perception.visible_people.slice(0, 5).map((person) => person.name ?? person.identity_status);
    const facts = `現在の身体観測（数値は会話用の概数）: 室温=${describe(environment.temperature, quantization.temperatureC, "℃")}; `
        + `湿度=${describe(environment.humidity, quantization.humidityPercent, "%")}; `
        + `明るさ=${describe(environment.brightness, quantization.brightnessRaw)}; `
        + `在室=${describe(snapshot.world.room.is_occupied)}; `
        + `温熱状態=${describe(snapshot.world.environment.thermal_condition)}; `
        + `撫でられている=${describe(snapshot.state.interaction.being_petted)}; `
        + `見えている人物=${people.join("、") || "未確認"}。unknown は未取得、stale は古い情報。`;
    const level = snapshot.drives.external[intoxicationSignal]?.level;
    const band = typeof level !== "number" ? "unknown" : level < quantization.lightIntoxication ? "sober"
        : level < quantization.moderateIntoxication ? "light" : "moderate";
    const style = { unknown: "身体側の酔い状態は不明。普段どおりに話し、酔っていると推測しない。",
        sober: "現在は素面。普段の話し方に戻す。以前の酔った話し方の指示を解除する。",
        light: "現在は軽い酔い状態。普段の人格を保ち、少しゆっくり、語尾を柔らかく話す。",
        moderate: "現在は酔い状態が強まっている。普段の人格を保ち、少し甘える調子で、時々短く言い直す。聞き取れる明瞭さは保つ。" }[band];
    return { facts, style };
}
