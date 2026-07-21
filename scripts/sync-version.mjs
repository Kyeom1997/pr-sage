// Runs from the npm "version" lifecycle hook: pins action.yml's npx call to
// the version just written to package.json, so the Action always runs the
// release it was tagged with.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const action = readFileSync("action.yml", "utf8");
const updated = action.replace(/pr-sage@\d+\.\d+\.\d+/g, `pr-sage@${version}`);
if (updated === action && !action.includes(`pr-sage@${version}`)) {
  throw new Error("action.yml has no pr-sage@x.y.z pin to update");
}
writeFileSync("action.yml", updated);
console.log(`action.yml pinned to pr-sage@${version}`);
