import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-neutral-200 bg-white/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/40", className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
