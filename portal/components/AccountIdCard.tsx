"use client";

// AccountIdCard — the user's photo avatar in the topbar + the SEALED ID-CARD it opens on click
// ("like an agent ID card"). The seam was pre-built on VrxLogoMark (photoUrl + onClick props); this
// component supplies them for the connected account and renders the card modal.
//
// WHAT THE CARD SHOWS (self view — the owner looking at their own card):
//   • the public portrait (display variant, watermarked)
//   • the vetted profile identity (legal name / region / role) + the ✓ Vetted re-hash result (from /api/profiles)
//   • the account id
//   • the owner's OWN sealed ID document (passport), if on file — self may always see their own (viewer==subject)
//   • a button to add/replace the public photo (PhotoUploadTool)
//
// MASK-CORRECTNESS (S159d): this card is the SELF view. It NEVER shows another account's passport — the serve
// route fails closed for a sensitive image unless viewer==subject or a consented counterparty via a revealed
// offer. Here the viewer IS the subject, so the own-passport serve URL is authorized. A counterparty-facing
// profile view is a SEPARATE surface (publicDirectProfileView) and does not use this self card.

import { useCallback, useEffect, useState } from "react";
import VrxLogoMark from "@/components/VrxLogoMark";
import PhotoUploadTool from "@/components/PhotoUploadTool";
import SealedRing from "@/components/SealedRing";
import Portal from "@/components/Portal";
import { T } from "@/lib/theme";

type Portrait = { imageId: string; iconUrl: string; displayUrl: string } | null;
type PublicProfile = { account: string; role: string; legalName: string; region: string; vettedAt: number } | null;

// z-index must clear Leaflet's panes + controls (which sit up to ~1000 inside the map's stacking context) —
// the ID-card modal was rendering UNDER the building map. 100000 keeps it above any map layer.
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100000,
  display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};
const sheet: React.CSSProperties = {
  background: T.panel, border: `1px solid ${T.border}`, borderRadius: 16,
  width: "min(420px, 94vw)", maxHeight: "90vh", overflow: "auto", padding: 20,
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
};
const roleLabel: Record<string, string> = {
  developer: "Developer", agency: "Agency", agent: "Agent",
};

export default function AccountIdCard({ account }: { account: string }) {
  const [open, setOpen] = useState(false);
  const [portrait, setPortrait] = useState<Portrait>(null);
  const [hasPassport, setHasPassport] = useState(false);
  const [passportId, setPassportId] = useState<string | null>(null);
  const [profile, setProfile] = useState<PublicProfile>(null);
  const [verified, setVerified] = useState<boolean>(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [imgRes, profRes] = await Promise.all([
        fetch(`/api/account-images?account=${encodeURIComponent(account)}`),
        fetch(`/api/profiles?account=${encodeURIComponent(account)}`),
      ]);
      const img = await imgRes.json();
      setPortrait(img.portrait ?? null);
      setHasPassport(Boolean(img.passport));
      setPassportId(img.passport?.imageId ?? null);
      const prof = await profRes.json();
      setProfile(prof.profile ?? null);
      setVerified(Boolean(prof.verified));
    } catch {
      /* leave whatever loaded */
    }
  }, [account]);

  // Load the portrait eagerly so the topbar avatar shows the photo; reload the rest when the card opens.
  useEffect(() => {
    if (account) load();
  }, [account, load]);

  return (
    <>
      {/* The topbar avatar: the user's photo if set, else the brand mark — clicking opens the sealed card.
 Wrapped in SealedRing so a VETTED identity wears a visible holographic seal — not just a
          lock icon. The ring shows only when the identity seal verified; the small ✓ badge is hidden at this
          tiny size (showBadge=false) to avoid crowding the topbar. */}
      {/* stop the avatar click from bubbling to the mobile ☰ (TopbarMenu), which closes/unmounts its
          children on any inner click. Without this, tapping the avatar sets open=true on a component that is
          torn down in the SAME click, so the ID card "does nothing" on mobile (the modal portals to body, but
          this component holding `open` lives inside the menu subtree). stopPropagation is harmless on desktop
          (no wrapping menu to close). */}
      <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
        <SealedRing size={30} sealed={verified} showBadge={false}>
          <VrxLogoMark
            size={30}
            photoUrl={portrait?.iconUrl}
            alt={`${account} — open ID card`}
            onClick={() => {
              setEditing(false);
              load();
              setOpen(true);
            }}
          />
        </SealedRing>
      </span>

      {open && (
        <Portal>
        <div style={overlay} onClick={() => setOpen(false)}>
          <div style={sheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <strong style={{ fontSize: 15 }}>VRX Identity Card</strong>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ background: "none", border: "none", color: T.text, fontSize: 20, cursor: "pointer", lineHeight: 1 }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {editing ? (
              <PhotoUploadTool
                account={account}
                slot="portrait"
                onUploaded={() => {
                  setEditing(false);
                  load();
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                {/* Portrait (display, watermarked) or a placeholder — wrapped in the holographic SealedRing when
 the identity seal verifies: a vetted actor LOOKS sealed, with the ✓ seal badge.
                    The ring hugs the portrait even when there's no photo yet, so vetting reads visually either way. */}
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
                  <SealedRing size={160} sealed={verified}>
                    {portrait ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={portrait.displayUrl}
                        alt="Your VRX portrait"
                        style={{ width: 160, height: 160, objectFit: "cover", borderRadius: "50%", border: `1px solid ${T.border}` }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 160, height: 160, borderRadius: "50%", border: `1px dashed ${T.border}`,
                          display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.6, fontSize: 13, textAlign: "center",
                        }}
                      >
                        No photo yet
                      </div>
                    )}
                  </SealedRing>
                </div>

                {/* Identity block. */}
                <div style={{ fontSize: 14, lineHeight: 1.7 }}>
                  {profile ? (
                    <>
                      <div><span style={{ opacity: 0.6 }}>Name: </span>{profile.legalName}</div>
                      <div><span style={{ opacity: 0.6 }}>Role: </span>{roleLabel[profile.role] ?? profile.role}</div>
                      <div><span style={{ opacity: 0.6 }}>Region: </span>{profile.region}</div>
                      <div style={{ color: verified ? "#38d39f" : T.danger, fontSize: 12.5, marginTop: 4 }}>
                        {verified ? "✓ Vetted — identity seal verifies" : "⚠ identity seal not verified"}
                      </div>
                    </>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No vetted profile on file for this account.</div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55, wordBreak: "break-all" }}>{account}</div>
                </div>

                {/* Own sealed ID document (self may always view their own — viewer==subject). */}
                {hasPassport && passportId && (
                  <details style={{ marginTop: 14 }}>
                    <summary style={{ cursor: "pointer", fontSize: 13, opacity: 0.85 }}>
                      Your sealed ID document (visible only to you)
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/images/${passportId}?variant=display&viewer=${encodeURIComponent(account)}`}
                        alt="Your sealed ID document"
                        style={{ width: "100%", borderRadius: 10, border: `1px solid ${T.border}` }}
                      />
                      <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>
                        Stored as sensitive data. Counterparties only ever see this with your explicit consent, and
                        their copy carries an invisible trace.
                      </div>
                    </div>
                  </details>
                )}

                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  style={{
                    marginTop: 16, width: "100%", background: T.panel2, border: `1px solid ${T.border}`,
                    color: T.text, cursor: "pointer", fontSize: 13.5, padding: "9px 14px", borderRadius: 8,
                  }}
                >
                  {portrait ? "Change photo" : "Add a photo"}
                </button>
              </>
            )}
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}
