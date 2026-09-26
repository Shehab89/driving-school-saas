/** Writes the brand files to public/brand (npm run brand). */
import { writeFileSync, mkdirSync } from "node:fs";
import { lockupSvg, markSvg } from "../src/lib/brand";

mkdirSync("public/brand", { recursive: true });
writeFileSync("public/brand/drivedesk-mark.svg", markSvg("company"));
writeFileSync("public/brand/student-app-icon.svg", markSvg("student"));
writeFileSync("public/brand/instructor-app-icon.svg", markSvg("instructor"));
writeFileSync("public/brand/drivedesk-logo.svg", lockupSvg(false));
writeFileSync("public/brand/drivedesk-logo-dark.svg", lockupSvg(true));
console.log("brand files written");
