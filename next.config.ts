import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Render metadata (manifest, apple-touch-icon, theme colour) in <head> for every browser
  // instead of streaming it into <body>: Chrome ignores a manifest link in the body, which
  // stops the student/instructor apps from being installable, and iOS reads the home-screen
  // icon from <head>.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
