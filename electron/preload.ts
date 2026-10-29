import { contextBridge, ipcRenderer } from "electron";

// Only "sb:" channels are reachable from the renderer.
const ok = (ch: string) => typeof ch === "string" && ch.startsWith("sb:");

contextBridge.exposeInMainWorld("sparkbench", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ok(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    if (!ok(channel)) return () => {};
    const h = (_e: unknown, ...a: unknown[]) => cb(...a);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
