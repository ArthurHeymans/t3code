import { useEffect, useState } from "react";
import {
  localSharingStatus,
  onLocalSharingChanged,
  setLocalSharing,
} from "../../connection/localSharing";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export function LocalConnectionSharing() {
  const [status, setStatus] = useState({
    available: false,
    enabled: false,
    serverEnabled: false,
    needsReenable: false,
    syncError: false,
  });
  const change = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    void setLocalSharing(enabled)
      .then(() => localSharingStatus())
      .then(setStatus)
      .catch(() =>
        setError(
          "Could not update sharing. Reconnect to the local primary server with administrator permissions and retry.",
        ),
      )
      .finally(() => setBusy(false));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void localSharingStatus().then((next) => {
        if (active) setStatus(next);
      });
    };
    refresh();
    const unsubscribe = onLocalSharingChanged(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">Share connections with local clients</span>
        <Switch
          aria-label="Share connections with local clients"
          checked={status.enabled}
          disabled={!status.available || busy}
          onCheckedChange={change}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Explicitly copy enabled bearer connections and their tokens to this local T3 server,
        encrypted at rest, for trusted local clients such as Emacs. Relay credentials and the
        primary connection are never shared. Switching this off clears the shared copy and
        disconnects local client attachments.
      </p>
      {status.needsReenable && (
        <p className="text-xs text-muted-foreground">
          This browser has no current sharing grant. Enable sharing again to replace the shared copy
          with this browser's connections.
        </p>
      )}
      {status.available && status.serverEnabled && !status.enabled && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => change(false)}>
          Clear shared copy
        </Button>
      )}
      {!status.available && (
        <p className="text-xs text-muted-foreground">
          Unavailable: open a loopback-hosted primary server with administrator permissions. Remote,
          relay, and tunnel origins cannot share connections.
        </p>
      )}
      {(error || status.syncError) && (
        <p className="text-xs text-destructive">
          {error ??
            "Sharing sync failed. Browser connections are still saved locally; reconnect or switch sharing off and retry."}
        </p>
      )}
    </div>
  );
}
