import { defineConfig } from "vitest/config";
import path from "node:path";

const db = process.env.TEST_DB_NAME ?? "driving_school_test";
const host = process.env.TEST_DB_HOST ?? "localhost:5432";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    globalSetup: ["tests/integration/global-setup.ts"],
    testTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      TEST_DB_NAME: db,
      DATABASE_OWNER_URL: process.env.TEST_DATABASE_OWNER_URL ?? `postgres://postgres:postgres@${host}/${db}`,
      DATABASE_URL: `postgres://dsa_app_login:dsa_app_dev@${host}/${db}`,
      DATABASE_PLATFORM_URL: `postgres://dsa_platform_login:dsa_platform_dev@${host}/${db}`,
      APP_URL: "http://localhost:3000",
      SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      EMAIL_PROVIDER: "console",
      PAYMENT_PROVIDER: "stripe",
      WHATSAPP_SENDER: "recording",
    },
  },
});
