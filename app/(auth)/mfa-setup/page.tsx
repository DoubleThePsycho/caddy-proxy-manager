import { redirect } from "next/navigation";
import { auth } from "@/src/lib/auth";
import { getMfaStatus } from "@/src/lib/mfa";
import { passkeyRegistrationBlocker } from "@/src/lib/passkeys";
import MfaSetupClient from "./MfaSetupClient";

/**
 * Setting up MFA outside the dashboard. Accounts the MFA policy covers land
 * here after sign-in; once its grace period is over, their dashboard sessions
 * can reach nothing else until they finish.
 */
export default async function MfaSetupPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }
  const status = await getMfaStatus(Number(session.user.id));
  if (status.enabled || !status.hasPassword) {
    redirect("/");
  }
  return (
    <MfaSetupClient
      gate={status.gate}
      deadline={status.deadline}
      canAddPasskey={await passkeyRegistrationBlocker(Number(session.user.id)) === null}
    />
  );
}
