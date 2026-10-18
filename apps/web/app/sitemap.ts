import type { MetadataRoute } from "next";

/** A private instance must not advertise the upstream marketing origin. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [];
}
