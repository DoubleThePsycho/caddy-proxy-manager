"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";

/**
 * One-time backup codes, shown once right after they were generated. They
 * are never shown again: the server keeps them encrypted and only reports how
 * many are left.
 */
export function BackupCodesPanel({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const { productName } = useBranding();
  const text = codes.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const header = `${productName} backup codes\nEach code signs you in once when you cannot use your authenticator app.\n\n`;
    const url = URL.createObjectURL(new Blob([header, text, "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account"}-backup-codes.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Save these backup codes somewhere safe, such as a password manager. Each one signs you in once if you lose
        your authenticator app. They are not shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-sm" data-testid="mfa-backup-codes">
        {codes.map((code) => (
          <span key={code} className="select-all">{code}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Download
        </Button>
      </div>
    </div>
  );
}
