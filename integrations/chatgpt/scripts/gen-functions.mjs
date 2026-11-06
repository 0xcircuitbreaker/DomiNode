// Regenerate functions.json from the built handler: npm run build && npm run gen:functions
import { writeFileSync } from "node:fs";
import { functionDefinitions } from "../dist/handler.js";

writeFileSync(new URL("../functions.json", import.meta.url), JSON.stringify(functionDefinitions(), null, 2) + "\n");
