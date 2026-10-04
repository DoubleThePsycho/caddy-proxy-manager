// SPDX-License-Identifier: Elastic-2.0
"use client";

import { RefreshCw } from "lucide-react";
import { ConfigureLink, enabledStatus, Fact, plural, SourceCard, Sub, type Formatters } from "@/src/components/sign-in/source-card";
import type { ScimSourceView } from "@/src/lib/sign-in-overview";

/** SCIM provisioning on the Sign-in and directories page. */
export function ScimSourceCard({ scim, format }: { scim: ScimSourceView; format: Formatters }) {
  const token = scim.tokens.latest;
  return (
    <SourceCard
      icon={RefreshCw}
      title="SCIM provisioning"
      subtitle="SCIM 2.0: creates, updates and disables accounts"
      status={enabledStatus(scim.enabled, "Accepting requests", "Off")}
      footerNote={
        <>
          {plural(scim.tokens.count, "token")}
          {token ? <>, latest <span className="num">{token.prefix}…</span> ({token.name})</> : ""}
          {!scim.configurable ? " · read-only without a license" : ""}
        </>
      }
      footerActions={<ConfigureLink href="/scim" name="SCIM provisioning" />}
    >
      <Fact label="Last activity">
        {scim.lastChange ? (
          <>
            <span>
              Change <span className="num">{format.dateTime(scim.lastChange.at)}</span>
            </span>
            <Sub>{scim.lastChange.summary}</Sub>
          </>
        ) : token?.lastUsedAt ? (
          <>
            <span>
              Request <span className="num">{format.dateTime(token.lastUsedAt)}</span>
            </span>
            <Sub>Token {token.name}</Sub>
          </>
        ) : (
          <span className="text-muted-foreground">No request yet</span>
        )}
      </Fact>
      <Fact label="Users from it">
        <span>
          <span className="num">{scim.users.total}</span> user{scim.users.total === 1 ? "" : "s"}, <span className="num">{scim.groups}</span> group{scim.groups === 1 ? "" : "s"}
        </span>
        {scim.users.names.length > 0 && (
          <Sub>
            {scim.users.names.join(", ")}
            {scim.users.total > scim.users.names.length ? ` and ${scim.users.total - scim.users.names.length} more` : ""}
          </Sub>
        )}
      </Fact>
      <Fact label="Group-to-role mappings">
        {scim.mappings.length === 0 ? (
          <>
            <span>None</span>
            <Sub>New SCIM users get {scim.defaultRole}</Sub>
          </>
        ) : (
          <>
            <span>
              <span className="num">{scim.mappings.length}</span> · manage roles {scim.manageRoles ? "on" : "off"}
            </span>
            <Sub>
              {scim.mappings.slice(0, 3).map((mapping) => `${mapping.group} to ${mapping.role}`).join(", ")}
              {scim.mappings.length > 3 ? ` and ${scim.mappings.length - 3} more` : ""}
            </Sub>
          </>
        )}
      </Fact>
      <Fact label="Sign-in and leavers">
        <span>{scim.signInProvider ? `Through ${scim.signInProvider}` : "No sign-in provider chosen"}</span>
        <Sub>{scim.deleteMode === "disable" ? "Leavers are disabled, not deleted" : "Leavers are deleted"}</Sub>
      </Fact>
      <Fact label="Base URL" wide>
        <span className="num break-all">{scim.endpointUrl}</span>
      </Fact>
    </SourceCard>
  );
}
