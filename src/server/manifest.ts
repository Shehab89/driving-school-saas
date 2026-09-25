/** Web app manifests: the two apps install separately on a phone's home screen. */
export function appManifest(app: "student" | "instructor") {
  const student = app === "student";
  return Response.json(
    {
      id: `/${app}`,
      name: student ? "DriveDesk Student" : "DriveDesk Instructor",
      short_name: student ? "Student" : "Instructor",
      start_url: `/${app}`,
      scope: "/",
      display: "standalone",
      background_color: "#f5f6f8",
      theme_color: student ? "#1f6feb" : "#1a7f37",
      icons: [{ src: `/icons/${app}.svg`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    },
    { headers: { "content-type": "application/manifest+json" } },
  );
}

export function appIcon(app: "student" | "instructor") {
  const bg = app === "student" ? "#1f6feb" : "#1a7f37";
  const letter = app === "student" ? "L" : "I";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${bg}"/><rect x="136" y="136" width="240" height="240" rx="24" fill="#fff"/><text x="256" y="330" font-family="Arial, Helvetica, sans-serif" font-size="210" font-weight="700" text-anchor="middle" fill="${bg}">${letter}</text></svg>`;
}
