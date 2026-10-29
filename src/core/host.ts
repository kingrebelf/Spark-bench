// Bridge to the Electron main process. In a plain browser (vite dev without Electron)
// `available` is false and callers fall back to browser downloads/uploads.

export interface HostApi {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window { sparkbench?: HostApi }
}

export const host = {
  get available() { return typeof window !== "undefined" && !!window.sparkbench; },
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (!window.sparkbench) return Promise.reject(new Error("This action needs the desktop app (Electron)."));
    return window.sparkbench.invoke<T>(channel, ...args);
  },
  on(channel: string, cb: (...args: unknown[]) => void): () => void {
    return window.sparkbench?.on(channel, cb) ?? (() => {});
  },
};
