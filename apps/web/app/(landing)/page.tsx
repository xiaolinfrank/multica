import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: { absolute: "BayClaw · 项目与任务执行工作台" },
  description: "由星舵个人分身统筹的项目与任务执行工作台。",
};

// Self-hosted workbench entry; authenticated users continue to their workspace.
export default function LandingPage() {
  redirect("/login");
}
