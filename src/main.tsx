import "./library";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { useProject } from "./core/store";
import { useSim } from "./sim/store";
import "./app/theme.css";

// Dev-only handle for scripted UI checks (browser pane / Playwright). Not present in builds.
if (import.meta.env.DEV) (window as any).__sb = { useProject, useSim };

createRoot(document.getElementById("root")!).render(<App />);
