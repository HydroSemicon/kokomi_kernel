// UTF-8 bytes are a conservative upper bound on byte-tokenizer tokens.
// This deliberately underfills Japanese text instead of guessing token counts.
export const textCost = (text) => Buffer.byteLength(String(text), "utf8");

export function fitText(text, budget) {
    let result = "";
    for (const character of String(text)) {
        if (textCost(result) + textCost(character) > budget) break;
        result += character;
    }
    return result;
}

export function textChunks(text, budget) {
    if (!Number.isInteger(budget) || budget < 8) throw new TypeError("Invalid text budget");
    const chunks = [];
    let chunk = "";
    for (const character of String(text)) {
        if (textCost(chunk) + textCost(character) > budget) {
            chunks.push(chunk);
            chunk = "";
        }
        chunk += character;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}
