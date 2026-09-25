/** Run background jobs once (use from a system cron if you don't call /api/cron/tick). */
import { closePools } from "../src/lib/db";
import { runAllJobs } from "../src/server/jobs";

runAllJobs()
  .then((r) => console.log(JSON.stringify(r)))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closePools);
