"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ALLOWED_TYPES = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["application/pdf", ".pdf"],
]);
function hasExpectedSignature(type,data){
  if(type==="image/jpeg")return data.length>=3&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff;
  if(type==="image/png")return data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(type==="image/webp")return data.subarray(0,4).toString()==="RIFF"&&data.subarray(8,12).toString()==="WEBP";
  if(type==="application/pdf")return data.subarray(0,5).toString()==="%PDF-";
  return false;
}

class LocalFileStorage {
  constructor({ rootDir, maxBytes = 5_000_000 } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxBytes = maxBytes;
  }

  async saveDataUrl(dataUrl, originalName = "receipt") {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl || ""));
    const extension = match && ALLOWED_TYPES.get(match[1].toLowerCase());
    if (!match || !extension) throw Object.assign(new Error("Чек должен быть изображением JPG, PNG, WEBP или PDF"), { statusCode: 422 });
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.length > this.maxBytes) throw Object.assign(new Error("Размер чека не должен превышать 5 МБ"), { statusCode: 413 });
    if(!hasExpectedSignature(match[1].toLowerCase(),data))throw Object.assign(new Error("Содержимое файла не соответствует его формату"),{statusCode:422});
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const key = `${crypto.randomUUID()}${extension}`;
    const destination = path.join(this.rootDir, key);
    const temporary = `${destination}.tmp`;
    await fs.promises.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await fs.promises.rename(temporary, destination);
    return { key, originalName: path.basename(originalName).slice(0, 255), mimeType: match[1].toLowerCase(), sizeBytes: data.length, uploadedAt: new Date().toISOString() };
  }

  resolve(key) {
    if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp|pdf)$/i.test(String(key || ""))) return null;
    const file = path.resolve(this.rootDir, key);
    return file.startsWith(`${this.rootDir}${path.sep}`) ? file : null;
  }

  async remove(key) {
    const file = this.resolve(key);
    if (file) await fs.promises.unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

module.exports = { LocalFileStorage };
