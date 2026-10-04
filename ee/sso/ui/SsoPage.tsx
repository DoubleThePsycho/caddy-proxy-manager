// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getSsoEnforcementView, listBreakGlassCandidates } from "@/ee/sso/enforcement";
import SsoClient from "@/ee/sso/ui/SsoClient";
import { saveSsoEnforcementAction } from "./actions";

export const metadata = { title: "Single sign-on" };

export default async function SsoPage() {
  const { access } = await requirePermission("sso:read");
  const enforcement = await getSsoEnforcementView();
  return (
    <SsoClient
      enforcement={enforcement}
      candidates={await listBreakGlassCandidates()}
      saveEnforcement={saveSsoEnforcementAction}
      canReadSettings={can(access, "settings:read")}
    />
  );
}
