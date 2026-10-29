// Library entry point. Import this once at startup (app and tests) to register all parts.
import { registerParts } from "../core/library";
import type { ComponentDef } from "../core/types";
import { analogParts } from "./analog";
import { connectorParts } from "./connectors";
import { digitalParts } from "./digital";
import { passiveParts } from "./passive";
import { semiconductorParts } from "./semiconductors";
import { sourceParts } from "./sources";
import { timerParts } from "./timer";

export const libraryParts: ComponentDef[] = [
  ...passiveParts, ...sourceParts, ...semiconductorParts, ...analogParts, ...digitalParts, ...timerParts, ...connectorParts,
];

export function registerLibrary(): void {
  registerParts(libraryParts);
}
registerLibrary();

export {
  importSpiceText, parseSpiceModels, registerImportedModels, compatibleModels, checkModelAssignment, partsForModel, subcktPart, MODEL_SLOTS,
} from "./spiceImport";
