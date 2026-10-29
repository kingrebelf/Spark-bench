// API key storage logic for the Electron main process. Encryption and file I/O are injected so the
// rules are testable without Electron: in the app they are `safeStorage` (DPAPI on Windows) and a
// JSON file in userData. Keys never leave the main process; the renderer only sees KeyStatus.
import type { ProviderId } from "./providers";

export type KeyProvider = Exclude<ProviderId, "codex">;

export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Uint8Array;
  decryptString(data: Uint8Array): string;
}
export interface VaultStorage {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

interface StoredKey { data: string /* base64 of encrypted bytes */; boundTo?: string /* base URL for compatible servers */ }
type Stored = Partial<Record<KeyProvider, StoredKey>>;

export type KeyStatus = Record<KeyProvider, boolean>;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class KeyVault {
  constructor(private crypto: Crypto, private storage: VaultStorage) {}

  private async load(): Promise<Stored> {
    const t = await this.storage.read();
    if (!t) return {};
    try { return JSON.parse(t) as Stored; } catch { return {}; }
  }

  /**
   * Store a key. Refuses (throws) when OS encryption is unavailable: there is no plaintext fallback.
   * For the OpenAI-compatible provider the key is bound to `baseUrl` and only released for that URL.
   */
  async set(provider: KeyProvider, key: string, baseUrl?: string): Promise<void> {
    const k = key.trim();
    if (!k) throw new Error("The key is empty.");
    if (/\s/.test(k)) throw new Error("The key contains spaces or line breaks; paste only the key.");
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error("Secure storage is not available on this system, so the key was not saved. SparkBench never stores API keys unencrypted.");
    }
    const s = await this.load();
    s[provider] = { data: b64(this.crypto.encryptString(k)), ...(provider === "compatible" ? { boundTo: baseUrl ?? "" } : {}) };
    await this.storage.write(JSON.stringify(s));
  }

  async clear(provider: KeyProvider): Promise<void> {
    const s = await this.load();
    delete s[provider];
    await this.storage.write(JSON.stringify(s));
  }

  /** Decrypted key for use in the main process only. For "compatible", null unless `baseUrl` matches. */
  async get(provider: KeyProvider, baseUrl?: string): Promise<string | null> {
    const e = (await this.load())[provider];
    if (!e) return null;
    if (provider === "compatible" && e.boundTo !== (baseUrl ?? "")) return null;
    if (!this.crypto.isEncryptionAvailable()) return null;
    try { return this.crypto.decryptString(unb64(e.data)); } catch { return null; }
  }

  /** What the renderer may know: whether a usable key is stored, nothing else. */
  async status(compatibleBaseUrl: string): Promise<KeyStatus> {
    const s = await this.load();
    return { anthropic: !!s.anthropic, openai: !!s.openai, compatible: !!s.compatible && s.compatible.boundTo === compatibleBaseUrl };
  }

  /** Called when the compatible base URL changes: the old key must not follow to a new host. */
  async rebindCheck(newBaseUrl: string): Promise<boolean> {
    const s = await this.load();
    if (s.compatible && s.compatible.boundTo !== newBaseUrl) { await this.clear("compatible"); return true; }
    return false;
  }
}
