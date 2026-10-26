import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const NAV = [
  { id: "overview", href: "/", label: "Overview" },
  { id: "usage", href: "/usage", label: "Usage" },
  { id: "config", href: "/config", label: "Configuration audit" },
  { id: "recommendations", href: "/recommendations", label: "Recommendations" },
  { id: "quality", href: "/quality", label: "Data quality" },
  { id: "history", href: "/history", label: "Run history" },
  { id: "sources", href: "/sources", label: "Source coverage" },
] as const;

export type NavId = (typeof NAV)[number]["id"];

export function Shell({ active, title, children }: { active: NavId; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header>
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Claude Code Control Center · read-only · local</p>
        <nav aria-label="Sections" className="mt-3 flex flex-wrap gap-2">
          {NAV.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={item.id === active ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
                item.id === active ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mt-6 space-y-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </main>
    </div>
  );
}
