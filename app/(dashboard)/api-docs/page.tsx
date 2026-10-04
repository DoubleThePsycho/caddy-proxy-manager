import Link from "next/link";
import { Braces, KeyRound } from "lucide-react";
import { requirePermission } from "@/src/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/button";
import ApiDocsClient from "./ApiDocsClient";

export const metadata = {
  title: "API reference",
};

export default async function ApiDocsPage() {
  await requirePermission("api_docs:read");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Account", "API reference"]}
        title="API reference"
        description={
          <>
            Every endpoint under <span className="num">/api/v1</span>, with its parameters, request bodies and responses.
            Scripts and tools send an API token as a bearer token; you create tokens on your profile.
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href="/api/v1/openapi.json" target="_blank" rel="noopener">
                <Braces aria-hidden="true" />
                OpenAPI document
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link href="/profile#api-tokens">
                <KeyRound aria-hidden="true" />
                API tokens
              </Link>
            </Button>
          </>
        }
      />
      <ApiDocsClient />
    </div>
  );
}
