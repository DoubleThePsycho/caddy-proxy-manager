"use client";

import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import "./swagger-ui-overrides.css";
import { ensureOpenApi31Refractors } from "./apidom-refractors";

// Before Swagger UI reads our OpenAPI 3.1 document (see apidom-refractors.ts).
ensureOpenApi31Refractors();

/**
 * API documentation is bundled with the application. Keeping executable assets
 * same-origin avoids granting a mutable CDN administrator-level script access.
 */
export default function ApiDocsClient() {
  return (
    <section aria-label="Endpoints" className="api-docs min-h-[600px] min-w-0 overflow-x-auto rounded-2xl border border-line bg-panel py-2">
      <SwaggerUI url="/api/v1/openapi.json" deepLinking defaultModelsExpandDepth={1} />
    </section>
  );
}
