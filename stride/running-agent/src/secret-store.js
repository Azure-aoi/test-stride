import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

function loadMasterKey() {
  if (process.env.MASTER_ENCRYPTION_KEY) {
    const configured = Buffer.from(process.env.MASTER_ENCRYPTION_KEY, "base64");
    if (configured.length !== 32) {
      throw new Error("MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
    return configured;
  }

  const keyPath = path.join(dataDir, "master.key");
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

const masterKey = loadMasterKey();

export function encryptSecret(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value) {
  if (!value) return null;
  const [ivPart, tagPart, ciphertextPart] = String(value).split(".");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Encrypted secret is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
