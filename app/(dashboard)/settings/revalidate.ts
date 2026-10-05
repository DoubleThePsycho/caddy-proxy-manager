import { revalidatePath } from "next/cache";
import { SETTINGS_PAGES } from "@/src/lib/settings-sections";

/**
 * After a settings change: every page that shows settings (src/lib/settings-sections.ts),
 * since some settings appear on more than one of them (the contact e-mail and
 * the primary domain are saved together, the shared state uses the certificate
 * storage's connection).
 */
export function revalidateSettingsPages(): void {
  for (const path of SETTINGS_PAGES) revalidatePath(path);
}
