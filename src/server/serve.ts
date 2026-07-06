import "dotenv/config";

import { createToolContextFromEnv } from "../agent.js";
import { createDisplayServer } from "./display-server.js";

const ctx = await createToolContextFromEnv();
const host = process.env["COMPASS_DISPLAY_HOST"] ?? "127.0.0.1";
const port = Number(process.env["COMPASS_DISPLAY_PORT"] ?? 8788);
const corsOrigin = process.env["COMPASS_DISPLAY_CORS_ORIGIN"];
const bearerToken = process.env["COMPASS_DISPLAY_TOKEN"];

const server = createDisplayServer(ctx, {
  ...(corsOrigin === undefined ? {} : { corsOrigin }),
  ...(bearerToken === undefined ? {} : { bearerToken }),
});

server.listen(port, host, () => {
  console.log(`Compass Health display API listening on http://${host}:${port} (user ${ctx.userId})`);
  if (bearerToken === undefined) {
    console.log("No COMPASS_DISPLAY_TOKEN set: localhost-trusted mode.");
  }
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received; shutting down.`);
    server.close(() => {
      void ctx.close().finally(() => process.exit(0));
    });
  });
}
