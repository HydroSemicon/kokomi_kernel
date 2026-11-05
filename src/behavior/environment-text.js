// Old assistant replies and summaries may contain readings from earlier versions.
const NUMBER = "[0-9０-９〇零一二三四五六七八九十百千万点.．]+";
const UNIT = new RegExp(`${NUMBER}\\s*(?:[℃℉]|[°º]\\s*[CF]|hPa\\b|ヘクトパスカル|度\\s*(?:[CF]|セルシウス))`, "iu");
const ENVIRONMENT = /室温|気温|温度|湿度|気圧|明るさ|照度|temperature|humidity|pressure|brightness|\blux\b/iu;
const QUANTITY = new RegExp(`${NUMBER}\\s*(?:度|[%％]|パーセント|ルクス|lux\\b|単位)`, "iu");

export function hasEnvironmentReading(text = "") {
    return UNIT.test(text) || (ENVIRONMENT.test(text) && QUANTITY.test(text));
}
