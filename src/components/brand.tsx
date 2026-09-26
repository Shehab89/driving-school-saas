import { markSvg, type MarkVariant } from "@/lib/brand";

/** The DriveDesk road-"D" mark as inline SVG. */
export function Mark({ variant = "company", size = 32, title }: { variant?: MarkVariant; size?: number; title?: string }) {
  const svg = markSvg(variant, size).replace('role="img" aria-label="DriveDesk"', title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"');
  return <span className="mark" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Mark + wordmark. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <Mark size={size} />
      <span className="wordmark">
        drive<span>desk</span>
      </span>
    </span>
  );
}
