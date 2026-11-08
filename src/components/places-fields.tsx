/** Pick-up and drop-off address fields (student profile and the office's student page). */
export function PlacesFields({ pickup, dropoff, located, labels }: {
  pickup: string | null;
  dropoff: string | null;
  /** false when the address was saved but could not be found on the map. */
  located: boolean;
  labels: { pickup: string; pickupHint: string; dropoff: string; dropoffHint: string; notFound: string; placeholder: string };
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="pickup">{labels.pickup}</label>
        <input id="pickup" name="pickup" defaultValue={pickup ?? ""} maxLength={200} placeholder={labels.placeholder} autoComplete="street-address" />
        <p className="muted small" style={{ margin: "4px 0 0" }}>{labels.pickupHint}</p>
        {pickup && !located && <p className="small" style={{ color: "var(--warning)", margin: "4px 0 0" }}>{labels.notFound}</p>}
      </div>
      <div className="field">
        <label htmlFor="dropoff">{labels.dropoff}</label>
        <input id="dropoff" name="dropoff" defaultValue={dropoff ?? ""} maxLength={200} placeholder={labels.placeholder} />
        <p className="muted small" style={{ margin: "4px 0 0" }}>{labels.dropoffHint}</p>
      </div>
    </>
  );
}
