// Library entry point. Import this once at startup (app and tests) to register all parts.
import { registerParts } from "../core/library";
import { basicParts } from "./basic";

export function registerLibrary(): void {
  registerParts(basicParts);
}
registerLibrary();
