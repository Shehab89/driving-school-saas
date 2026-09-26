import { BRAND, markSvg } from "@/lib/brand";
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
      background_color: "#F6F7F8",
      theme_color: student ? BRAND.amber : BRAND.asphalt,
      icons: [{ src: `/icons/${app}.svg`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    },
    { headers: { "content-type": "application/manifest+json" } },
  );
}

export function appIcon(app: "student" | "instructor") {
  return markSvg(app);
}
