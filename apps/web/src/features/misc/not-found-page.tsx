import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/layout/app-shell";

export function NotFoundPage() {
  return (
    <PageContainer width="narrow">
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="select-none text-[64px] font-semibold leading-none tracking-tight text-line-strong">
          404
        </p>
        <h1 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
          This page doesn't exist
        </h1>
        <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-muted">
          The link may be out of date, or the page may have moved. Use the navigation to get back to
          your workspace.
        </p>
        <Button asChild className="mt-6">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </div>
    </PageContainer>
  );
}
