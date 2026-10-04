"use client";

import { useState, useTransition } from "react";
import { Download, Upload } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readError, requestJson } from "@/src/lib/request-json";

type Props = {
  open: boolean;
  onClose: () => void;
  isSlave: boolean;
  allowed: { export: boolean; import: boolean };
  minPassphraseLength: number;
  /** History is recording: the configuration an import replaces is saved as a version first. */
  historyEnabled: boolean;
  /** An import replaced the configuration; the message says what happened. */
  onImported: (message: string) => void;
};

type Message = { ok: boolean; text: string } | null;

/**
 * Export and import of the configuration (free): a JSON file whose secrets are
 * encrypted with a passphrase the person chooses.
 */
export function TransferDialog({ open, onClose, isSlave, allowed, minPassphraseLength, historyEnabled, onImported }: Props) {
  const [pending, startTransition] = useTransition();
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportMessage, setExportMessage] = useState<Message>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<Message>(null);

  function downloadExport() {
    setExportMessage(null);
    if (exportPassphrase.length < minPassphraseLength) {
      setExportMessage({ ok: false, text: `Use a passphrase of at least ${minPassphraseLength} characters.` });
      return;
    }
    if (exportPassphrase !== exportConfirm) {
      setExportMessage({ ok: false, text: "The passphrases do not match." });
      return;
    }
    startTransition(async () => {
      try {
        const response = await fetch("/api/v1/config/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passphrase: exportPassphrase }),
        });
        if (!response.ok) throw new Error(await readError(response));
        const disposition = response.headers.get("content-disposition") ?? "";
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "ingressi-configuration.json";
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setExportPassphrase("");
        setExportConfirm("");
        setExportMessage({ ok: true, text: `Downloaded ${filename}. Keep the passphrase: the file cannot be imported without it.` });
      } catch (error) {
        setExportMessage({ ok: false, text: (error as Error).message });
      }
    });
  }

  function runImport() {
    if (!importFile) return;
    const form = new FormData();
    form.append("file", importFile);
    form.append("passphrase", importPassphrase);
    setImportMessage(null);
    startTransition(async () => {
      try {
        const result = await requestJson<{ warning: string | null; beforeSnapshotId: number | null }>("/api/v1/config/import", {
          method: "POST",
          body: form,
        });
        setImportConfirmOpen(false);
        setImportPassphrase("");
        setImportFile(null);
        onImported(
          "Imported the configuration." +
            (result.beforeSnapshotId ? ` The configuration it replaced is version #${result.beforeSnapshotId}.` : "") +
            (result.warning ? ` ${result.warning}.` : "")
        );
        onClose();
      } catch (error) {
        setImportConfirmOpen(false);
        setImportMessage({ ok: false, text: (error as Error).message });
      }
    });
  }

  const message = (value: Message) =>
    value && (
      <Banner tone={value.ok ? "ok" : "bad"} live>
        {value.text}
      </Banner>
    );

  return (
    <>
      <AppDialog
        open={open && !importConfirmOpen}
        onClose={onClose}
        title="Export or import the configuration"
        maxWidth="lg"
        actions={
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <p className="m-0 text-sm text-muted-foreground">
            A JSON file of the configuration. Its secrets (private keys, password hashes, DNS credentials) are encrypted with a passphrase you
            choose, so the file can move to another installation. Export and import are free.
          </p>
          {isSlave && (
            <Banner tone="info">This instance is a sync slave: export and import on the master.</Banner>
          )}

          <section aria-labelledby="export-title" className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <h3 id="export-title" className="m-0 text-sm font-semibold">
              Export
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="export-passphrase">Passphrase</Label>
                <Input
                  id="export-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={exportPassphrase}
                  onChange={(event) => setExportPassphrase(event.target.value)}
                  disabled={isSlave || pending || !allowed.export}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="export-confirm">Repeat passphrase</Label>
                <Input
                  id="export-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={exportConfirm}
                  onChange={(event) => setExportConfirm(event.target.value)}
                  disabled={isSlave || pending || !allowed.export}
                />
              </div>
            </div>
            <p className="m-0 text-xs text-muted-foreground">At least {minPassphraseLength} characters. Keep it in your password manager.</p>
            <div>
              <Button onClick={downloadExport} disabled={isSlave || pending || !exportPassphrase || !allowed.export}>
                <Download /> Export configuration
              </Button>
            </div>
            {message(exportMessage)}
          </section>

          <section aria-labelledby="import-title" className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <h3 id="import-title" className="m-0 text-sm font-semibold">
              Import
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="import-file">Export file</Label>
                <Input
                  id="import-file"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
                  disabled={isSlave || pending || !allowed.import}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="import-passphrase">Passphrase</Label>
                <Input
                  id="import-passphrase"
                  type="password"
                  autoComplete="off"
                  value={importPassphrase}
                  onChange={(event) => setImportPassphrase(event.target.value)}
                  disabled={isSlave || pending || !allowed.import}
                />
              </div>
            </div>
            <div>
              <Button
                variant="outline"
                onClick={() => setImportConfirmOpen(true)}
                disabled={isSlave || pending || !importFile || !importPassphrase || !allowed.import}
              >
                <Upload /> Import configuration…
              </Button>
            </div>
            {message(importMessage)}
          </section>
        </div>
      </AppDialog>

      <AppDialog
        open={open && importConfirmOpen}
        onClose={() => setImportConfirmOpen(false)}
        title="Replace the configuration?"
        submitLabel="Import"
        onSubmit={runImport}
        isSubmitting={pending}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="m-0">
            Every proxy host, certificate, access list and setting in this configuration is replaced with the content of{" "}
            <span className="font-medium">{importFile?.name}</span>, then applied to Caddy.
          </p>
          <p className="m-0 text-muted-foreground">
            Users, group members, sign-in settings and API tokens are not changed. Forward-auth sign-ins end.
            {historyEnabled ? " The current configuration is saved as a version first." : ""}
          </p>
        </div>
      </AppDialog>
    </>
  );
}
