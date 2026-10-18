import type { MetadataRoute } from "next";

/** Private self-hosted workbench; it has no public marketing sitemap. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
