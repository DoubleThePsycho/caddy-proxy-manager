"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { passwordPolicyMessage } from "@/src/lib/password-policy";
import { createUserAction } from "./actions";
import { RoleOptions, type RoleOptionsProps } from "./RolePicker";
import { runUserAction } from "./run-user-action";

type Props = {
  open: boolean;
  onClose: () => void;
  roleOptions: RoleOptionsProps;
  /** The organisation the user is created in (ee/multi-tenancy), or null for the provider level. */
  createOrganization: { id: number; name: string } | null;
};

/** Add user: a local account with a password. Directory, SAML and SCIM accounts arrive on their own. */
export default function CreateUserDialog({ open, onClose, roleOptions, createOrganization }: Props) {
  const router = useRouter();
  const [role, setRole] = useState("user");
  const [createError, setCreateError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = () => {
    setRole("user");
    setCreateError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            A local account that signs in with a password. People from a directory, a SAML provider or SCIM get their account at
            their first sign-in or when the identity provider sends it.
          </DialogDescription>
        </DialogHeader>
        <form
          // onSubmit rather than a form action: a form action resets the
          // fields when it finishes, which would clear them on an error.
          onSubmit={async (event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            formData.set("role", role);
            // Mirrors the server-side policy so most mistakes show up without a round trip.
            const policyError = passwordPolicyMessage(String(formData.get("password") ?? ""));
            if (policyError) {
              setCreateError(policyError);
              return;
            }
            setCreateError(null);
            setPending(true);
            const error = await runUserAction(() => createUserAction(formData), "Failed to create user");
            setPending(false);
            if (error) {
              setCreateError(error);
              return;
            }
            close();
            router.refresh();
          }}
          className="flex min-h-0 flex-col gap-4 overflow-y-auto"
        >
          {createError && (
            <Banner tone="bad" live>
              <span data-testid="create-error">{createError}</span>
            </Banner>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="create-email">Email</Label>
              <Input id="create-email" name="email" type="email" placeholder="user@example.com" required data-testid="create-email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-name">Name</Label>
              <Input id="create-name" name="name" placeholder="Display name" data-testid="create-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="create-role" data-testid="create-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <RoleOptions {...roleOptions} organization={createOrganization !== null} />
                </SelectContent>
              </Select>
              {createOrganization && <p className="text-xs text-muted-foreground">In organisation {createOrganization.name}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-password">Password</Label>
              <Input
                id="create-password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 12 characters"
                required
                minLength={12}
                data-testid="create-password"
              />
              <p className="text-xs text-muted-foreground">Upper and lower case, a number and a symbol.</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
