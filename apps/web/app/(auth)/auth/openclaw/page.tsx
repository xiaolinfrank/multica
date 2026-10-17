"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@multica/core/auth";
import { LocalDashboardPage } from "@multica/views/auth";

export default function Page() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login?next=%2Fauth%2Fopenclaw");
  }, [isLoading, user, router]);
  if (!user) return null;
  return <LocalDashboardPage email={user.email} onOpen={(url) => window.location.assign(url)} onWorkspace={() => router.push("/")} />;
}
