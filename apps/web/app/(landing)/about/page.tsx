import type { Metadata } from "next";
import { AboutPageClient } from "@/features/landing/components/about-page-client";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about BayClaw — multiplexed information and computing agent. An open-source project management platform for human + agent teams.",
  openGraph: {
    title: "About BayClaw",
    description:
      "The story behind BayClaw and why we're building project management for human + agent teams.",
    url: "/about",
  },
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return <AboutPageClient />;
}
