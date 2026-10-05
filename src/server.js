import { app } from "./app.js";
import { env } from "./config/env.js";
import { pingDb } from "./config/db.js";

async function start() {
  try {
    await pingDb();
    console.log("Database connection OK.");
  } catch (err) {
    console.error("Could not connect to the database:", err.message);
    process.exit(1);
  }

  app.listen(env.port, () => {
    console.log(`363 Cooperative Society API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

start();
