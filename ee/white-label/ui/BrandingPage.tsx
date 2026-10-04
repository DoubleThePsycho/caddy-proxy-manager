// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { getBrandingView } from "@/ee/white-label/service";
import { WHITE_LABEL_FEATURE } from "@/ee/white-label/types";
import BrandingClient from "@/ee/white-label/ui/BrandingClient";
import { deleteBrandingAssetAction, resetBrandingAction, saveBrandingAction, uploadBrandingAssetAction } from "./actions";

export const metadata = { title: "Branding" };

export default async function BrandingPage() {
  const { access } = await requirePermission("branding:read");
  const [view, mode] = await Promise.all([getBrandingView(), getInstanceMode()]);
  return (
    <BrandingClient
      view={view}
      canWrite={can(access, "branding:write")}
      isSlave={mode === "slave"}
      editionLabel={EDITION_LABELS[FEATURE_INFO[WHITE_LABEL_FEATURE].edition]}
      save={saveBrandingAction}
      upload={uploadBrandingAssetAction}
      removeAsset={deleteBrandingAssetAction}
      reset={resetBrandingAction}
    />
  );
}
