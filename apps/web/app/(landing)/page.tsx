import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: {
    absolute: "BayClaw —— 复星医药大湾区虚拟员工平台",
  },
  description:
    "BayClaw 是复星医药大湾区虚拟员工平台:把 AI 智能体作为数字员工纳入团队,在云端共享算力上分派任务、跟踪进度、沉淀技能。",
  alternates: {
    canonical: "/",
  },
};

// BayClaw is an internal, server-centric deployment — there is no public
// marketing site. The root goes straight to login; authenticated users are
// bounced onward to their workspace by the login page itself.
export default function LandingPage() {
  redirect("/login");
}
