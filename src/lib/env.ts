/** Typed, lazily-validated access to environment variables. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get databasePlatformUrl() {
    return required("DATABASE_PLATFORM_URL");
  },
  get appUrl() {
    return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  },
  get sessionSecret() {
    const s = required("SESSION_SECRET");
    if (s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return s;
  },
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  get emailProvider() {
    return process.env.EMAIL_PROVIDER ?? "console";
  },
  get emailFrom() {
    return process.env.EMAIL_FROM ?? "Driving School <no-reply@example.com>";
  },
  get resendApiKey() {
    return required("RESEND_API_KEY");
  },
  get paymentProvider() {
    return process.env.PAYMENT_PROVIDER ?? "stripe";
  },
  get stripeSecretKey() {
    return required("STRIPE_SECRET_KEY");
  },
  get stripeWebhookSecret() {
    return required("STRIPE_WEBHOOK_SECRET");
  },
  get metaAppSecret() {
    return required("META_APP_SECRET");
  },
  get whatsappVerifyToken() {
    return required("WHATSAPP_VERIFY_TOKEN");
  },
  get whatsappGraphVersion() {
    return process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
  },
  get agentModel() {
    return process.env.AGENT_MODEL ?? "claude-opus-5";
  },
};
