"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nContext";
import type { LoadingCollaboration } from "@/lib/architect/loadingPatternMembers";
import type { LoadingPattern } from "@/lib/architect/loadingPatterns";

export default function LoadingPatternTeam({
  collaboration,
  carriers,
  disabled,
  mutate,
}: {
  collaboration: LoadingCollaboration;
  carriers: LoadingPattern["carriers"];
  disabled: boolean;
  mutate: (
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
  ) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [cmdr, setCmdr] = useState("");
  const [shared, setShared] = useState<string[]>(
    collaboration.self.sharedCarrierIds,
  );
  const signature = JSON.stringify(collaboration.self.sharedCarrierIds);
  useEffect(() => {
    setShared(JSON.parse(signature));
  }, [signature]);
  return (
    <section className="card lp-team">
      <h2>{t("lp.team")}</h2>
      <p>{t("lp.teamHint")}</p>
      {!collaboration.self.accepted && <p role="status">{t("lp.invited")}</p>}
      <ul>
        {collaboration.participants.map((member) => (
          <li key={member.userId}>
            <strong>{member.name}</strong> ·{" "}
            {t(member.accepted ? "lp.accepted" : "lp.pending")}
            {member.sharedCarrierIds.length > 0 && (
              <span>
                {" "}
                ·{" "}
                {member.sharedCarrierIds
                  .map(
                    (id) =>
                      carriers.find((c) => c.carrierId === id)?.name ?? id,
                  )
                  .join(", ")}
              </span>
            )}
            {collaboration.canManage && (
              <button
                disabled={disabled}
                onClick={() => void mutate("DELETE", { userId: member.userId })}
              >
                {t("lp.removeMember")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {collaboration.canManage && (
        <div className="lp-actions">
          <input
            aria-label={t("lp.pilotName")}
            placeholder={t("lp.pilotName")}
            maxLength={100}
            disabled={disabled}
            value={cmdr}
            onChange={(event) => setCmdr(event.target.value)}
          />
          <button
            disabled={disabled || !cmdr.trim()}
            onClick={async () => {
              if (await mutate("POST", { cmdr })) setCmdr("");
            }}
          >
            {t("lp.invite")}
          </button>
        </div>
      )}
      <fieldset disabled={disabled}>
        <legend>{t("lp.shareCarriers")}</legend>
        <p>{t("lp.shareHint")}</p>
        {carriers
          .filter((carrier) =>
            collaboration.ownCarrierIds.includes(carrier.carrierId),
          )
          .map((carrier) => (
            <label key={carrier.carrierId} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={shared.includes(carrier.carrierId)}
                onChange={(event) =>
                  setShared((current) =>
                    event.target.checked
                      ? [...current, carrier.carrierId]
                      : current.filter((id) => id !== carrier.carrierId),
                  )
                }
              />{" "}
              {carrier.name} · {carrier.carrierId}
            </label>
          ))}
        {!collaboration.ownCarrierIds.length && <p>{t("lp.noOwnCarriers")}</p>}
        <button
          onClick={() =>
            void mutate("PATCH", {
              accept: true,
              sharedCarrierIds: shared.filter(
                (id) =>
                  collaboration.ownCarrierIds.includes(id) &&
                  carriers.some((carrier) => carrier.carrierId === id),
              ),
            })
          }
        >
          {t(
            collaboration.self.accepted
              ? "lp.saveSharing"
              : "lp.acceptInvitation",
          )}
        </button>
      </fieldset>
      {!collaboration.canManage && (
        <button disabled={disabled} onClick={() => void mutate("DELETE", {})}>
          {t("lp.leave")}
        </button>
      )}
    </section>
  );
}
